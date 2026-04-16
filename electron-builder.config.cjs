function parseTrustedSigningPublisherName(rawValue) {
  if (!rawValue) {
    return null;
  }

  const values = rawValue
    .split("|")
    .map((value) => value.trim())
    .filter(Boolean);

  if (values.length === 0) {
    return null;
  }

  return values.length === 1 ? values[0] : values;
}

const requireWindowsCodeSigning =
  process.env.WINDOWS_REQUIRE_CODE_SIGNING === "true";

const trustedSigningPublisherName = parseTrustedSigningPublisherName(
  process.env.WINDOWS_TRUSTED_SIGNING_PUBLISHER_NAME,
);

const hasTrustedSigningConfig = Boolean(
  trustedSigningPublisherName &&
    process.env.WINDOWS_TRUSTED_SIGNING_ENDPOINT &&
    process.env.WINDOWS_TRUSTED_SIGNING_ACCOUNT_NAME &&
    process.env.WINDOWS_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME,
);

const buildStoreMsix = process.env.BUILD_STORE_MSIX === "true";

const win = buildStoreMsix
  ? {
      target: [
        {
          target: "appx",
          arch: ["x64"],
        },
      ],
      icon: "resources/vessel-icon.png",
      artifactName: "${productName}-${version}-${arch}.${ext}",
    }
  : (() => {
      const config = {
        target: ["nsis"],
        icon: "resources/vessel-icon.png",
        artifactName: "${productName}-${version}-${arch}-setup.${ext}",
      };

      if (requireWindowsCodeSigning) {
        config.forceCodeSigning = true;
      }

      if (hasTrustedSigningConfig) {
        config.azureSignOptions = {
          publisherName: trustedSigningPublisherName,
          endpoint: process.env.WINDOWS_TRUSTED_SIGNING_ENDPOINT,
          codeSigningAccountName:
            process.env.WINDOWS_TRUSTED_SIGNING_ACCOUNT_NAME,
          certificateProfileName:
            process.env.WINDOWS_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME,
        };
      }

      return config;
    })();

module.exports = {
  appId: "com.quantaintellect.vessel",
  productName: "Vessel",
  asar: true,
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  files: ["out/**/*", "package.json"],
  extraResources: [
    {
      from: "resources/vessel-icon.png",
      to: "vessel-icon.png",
    },
  ],
  linux: {
    target: ["AppImage", "deb"],
    category: "Network;WebBrowser;",
    executableName: "vessel",
    icon: "resources/vessel-icon.png",
    artifactName: "${productName}-${version}-${arch}.${ext}",
  },
  deb: {
    packageName: "vessel",
  },
  mac: {
    target: ["dmg", "zip"],
    category: "public.app-category.productivity",
    icon: "vessel-icon.icns",
    artifactName: "${productName}-${version}-${arch}.${ext}",
  },
  dmg: {
    artifactName: "${productName}-${version}-${arch}.${ext}",
  },
  win,
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
  },
  appx: {
    applicationId: "QuantaIntellect.Vessel",
    identityName: "QuantaIntellect.Vessel",
    publisher: "CN=QuantaIntellect",
    publisherDisplayName: "Quanta Intellect",
  },
};
