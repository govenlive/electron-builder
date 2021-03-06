import { PlatformPackager } from "./platformPackager"
import { MasBuildOptions, MacOptions } from "./options/macOptions"
import * as path from "path"
import BluebirdPromise from "bluebird-lst-c"
import { warn, task } from "electron-builder-util/out/log"
import { createKeychain, CodeSigningInfo, findIdentity, appleCertificatePrefixes } from "./codeSign"
import { deepAssign } from "electron-builder-util/out/deepAssign"
import { signAsync, SignOptions } from "electron-macos-sign"
import { DmgTarget } from "./targets/dmg"
import { createCommonTarget, DIR_TARGET, NoOpTarget } from "./targets/targetFactory"
import { AppInfo } from "./appInfo"
import { PkgTarget, prepareProductBuildArgs } from "./targets/pkg"
import { exec } from "electron-builder-util"
import { Target, Platform, Arch } from "electron-builder-core"
import { BuildInfo } from "./packagerApi"
import { log } from "electron-builder-util/out/log"

export default class MacPackager extends PlatformPackager<MacOptions> {
  readonly codeSigningInfo: Promise<CodeSigningInfo>

  constructor(info: BuildInfo) {
    super(info)

    if (this.packagerOptions.cscLink == null || process.platform !== "darwin") {
      this.codeSigningInfo = BluebirdPromise.resolve(Object.create(null))
    }
    else {
      this.codeSigningInfo = createKeychain(info.tempDirManager, this.packagerOptions.cscLink!, this.getCscPassword(), this.packagerOptions.cscInstallerLink, this.packagerOptions.cscInstallerKeyPassword)
    }
  }

  get defaultTarget(): Array<string> {
    return ["zip", "dmg"]
  }

  protected prepareAppInfo(appInfo: AppInfo): AppInfo {
    return new AppInfo(appInfo.metadata, this.info, this.platformSpecificBuildOptions.bundleVersion)
  }

  async getIconPath(): Promise<string | null> {
    let iconPath = this.platformSpecificBuildOptions.icon || this.config.icon
    if (iconPath != null && !iconPath.endsWith(".icns")) {
      iconPath += ".icns"
    }
    return iconPath == null ? await this.getDefaultIcon("icns") : path.resolve(this.projectDir, iconPath)
  }

  createTargets(targets: Array<string>, mapper: (name: string, factory: (outDir: string) => Target) => void, cleanupTasks: Array<() => Promise<any>>): void {
    for (const name of targets) {
      switch (name) {
        case DIR_TARGET:
          break

        case "dmg":
          mapper("dmg", () => new DmgTarget(this))
          break

        case "pkg":
          mapper("pkg", () => new PkgTarget(this))
          break

        default:
          mapper(name, outDir => name === "mas" || name === "mas-dev" ? new NoOpTarget(name) : createCommonTarget(name, outDir, this))
          break
      }
    }
  }

  get platform() {
    return Platform.MAC
  }

  async pack(outDir: string, arch: Arch, targets: Array<Target>, postAsyncTasks: Array<Promise<any>>): Promise<any> {
    let nonMasPromise: Promise<any> | null = null

    const hasMas = targets.length !== 0 && targets.some(it => it.name === "mas" || it.name === "mas-dev")
    const prepackaged = this.packagerOptions.prepackaged

    if (prepackaged == null && (!hasMas || targets.length > 1)) {
      const appOutDir = this.computeAppOutDir(outDir, arch)
      nonMasPromise = this.doPack(outDir, appOutDir, this.platform.nodeName, arch, this.platformSpecificBuildOptions)
        .then(() => this.sign(appOutDir, null))
        .then(() => this.packageInDistributableFormat(appOutDir, Arch.x64, targets, postAsyncTasks))
    }

    for (const target of targets) {
      const targetName = target.name
      if (!(targetName === "mas" || targetName === "mas-dev")) {
        continue
      }

      const appOutDir = prepackaged || path.join(outDir, targetName)
      const masBuildOptions = deepAssign({}, this.platformSpecificBuildOptions, (<any>this.config).mas)
      if (targetName === "mas-dev") {
        deepAssign(masBuildOptions, (<any>this.config)[targetName])
        masBuildOptions.type = "development"
      }

      if (prepackaged == null) {
        await this.doPack(outDir, appOutDir, "mas", arch, masBuildOptions)
      }
      await this.sign(appOutDir, masBuildOptions)
    }

    if (nonMasPromise != null) {
      await nonMasPromise
    }
  }

  private async sign(appOutDir: string, masOptions: MasBuildOptions | null): Promise<void> {
    if (process.platform !== "darwin") {
      warn("macOS application code signing is supported only on macOS, skipping.")
      return
    }

    const keychainName = (await this.codeSigningInfo).keychainName
    const isMas = masOptions != null
    const qualifier = this.platformSpecificBuildOptions.identity

    if (!isMas && qualifier === null) {
      if (this.forceCodeSigning) {
        throw new Error("identity explicitly is set to null, but forceCodeSigning is set to true")
      }
      log("identity explicitly is set to null, skipping macOS application code signing.")
      return
    }

    const masQualifier = isMas ? (masOptions!!.identity || qualifier) : null

    const explicitType = masOptions == null ? this.platformSpecificBuildOptions.type : masOptions.type
    const type = explicitType || "distribution"
    const isDevelopment = type === "development"
    let name = await findIdentity(isDevelopment ? "Mac Developer" : (isMas ? "3rd Party Mac Developer Application" : "Developer ID Application"), isMas ? masQualifier : qualifier, keychainName)
    if (name == null) {
      if (!isMas && !isDevelopment && explicitType !== "distribution") {
        name = await findIdentity("Mac Developer", qualifier, keychainName)
        if (name != null) {
          warn("Mac Developer is used to sign app — it is only for development and testing, not for production")
        }
        else if (qualifier != null) {
          throw new Error(`Identity name "${qualifier}" is specified, but no valid identity with this name in the keychain`)
        }
      }

      if (name == null) {
        const message = process.env.CSC_IDENTITY_AUTO_DISCOVERY === "false" ?
          `App is not signed: env CSC_IDENTITY_AUTO_DISCOVERY is set to false` :
          `App is not signed: cannot find valid ${isMas ? '"3rd Party Mac Developer Application" identity' : `"Developer ID Application" identity or custom non-Apple code signing certificate`}, see https://github.com/electron-userland/electron-builder/wiki/Code-Signing`
        if (isMas || this.forceCodeSigning) {
          throw new Error(message)
        }
        else {
          warn(message)
          return
        }
      }
    }

    const appPath = path.join(appOutDir, `${this.appInfo.productFilename}.app`)
    const signOptions: any = {
      skipIdentityValidation: true,
      identity: name!,
      type: type,
      platform: isMas ? "mas" : "darwin",
      version: this.info.electronVersion,
      app: appPath,
      keychain: keychainName || undefined,
      "gatekeeper-assess": appleCertificatePrefixes.find(it => name!.startsWith(it)) != null
    }

    const resourceList = await this.resourceList
    if (resourceList.includes(`entitlements.osx.plist`)) {
      throw new Error("entitlements.osx.plist is deprecated name, please use entitlements.mac.plist")
    }
    if (resourceList.includes(`entitlements.osx.inherit.plist`)) {
      throw new Error("entitlements.osx.inherit.plist is deprecated name, please use entitlements.mac.inherit.plist")
    }

    const customSignOptions = masOptions || this.platformSpecificBuildOptions
    if (customSignOptions.entitlements == null) {
      const p = `entitlements.${isMas ? "mas" : "mac"}.plist`
      if (resourceList.includes(p)) {
        signOptions.entitlements = path.join(this.buildResourcesDir, p)
      }
    }
    else {
      signOptions.entitlements = customSignOptions.entitlements
    }

    if (customSignOptions.entitlementsInherit == null) {
      const p = `entitlements.${isMas ? "mas" : "mac"}.inherit.plist`
      if (resourceList.includes(p)) {
        signOptions["entitlements-inherit"] = path.join(this.buildResourcesDir, p)
      }
    }
    else {
      signOptions["entitlements-inherit"] = customSignOptions.entitlementsInherit
    }

    await task(`Signing app (identity: ${name})`, this.doSign(signOptions))

    if (masOptions != null) {
      const pkg = path.join(appOutDir, `${this.appInfo.productFilename}-${this.appInfo.version}.pkg`)
      const certType = "3rd Party Mac Developer Installer"
      const masInstallerIdentity = await findIdentity(certType, masOptions.identity, keychainName)
      if (masInstallerIdentity == null) {
        throw new Error(`Cannot find valid "${certType}" identity to sign MAS installer, please see https://github.com/electron-userland/electron-builder/wiki/Code-Signing`)
      }
      await this.doFlat(appPath, pkg, masInstallerIdentity, keychainName)
      this.dispatchArtifactCreated(pkg, null, `${this.appInfo.name}-${this.appInfo.version}.pkg`)
    }
  }

  //noinspection JSMethodCanBeStatic
  protected async doSign(opts: SignOptions): Promise<any> {
    return signAsync(opts)
  }

  //noinspection JSMethodCanBeStatic
  protected async doFlat(appPath: string, outFile: string, identity: string, keychain: string | n): Promise<any> {
    const args = prepareProductBuildArgs(identity, keychain)
    args.push("--component", appPath, "/Applications")
    args.push(outFile)
    return exec("productbuild", args)
  }
}