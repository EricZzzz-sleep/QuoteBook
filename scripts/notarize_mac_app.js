const { notarize } = require("@electron/notarize");

exports.default = async function notarizeMacApp(context) {
  if (context.electronPlatformName !== "darwin") return;

  const {
    APPLE_ID,
    APPLE_APP_SPECIFIC_PASSWORD,
    APPLE_TEAM_ID,
  } = process.env;

  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log("Skipping notarization because Apple notarization credentials are not configured.");
    return;
  }

  await notarize({
    appBundleId: "com.quotebook.app",
    appPath: `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });
};
