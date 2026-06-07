const { spawnSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function signMacApp(context) {
  if (context.electronPlatformName !== "darwin") return;

  if (process.env.MAC_CERTIFICATE || process.env.CSC_LINK) {
    console.log("Skipping ad-hoc signing because Apple signing credentials are configured.");
    return;
  }

  console.log("Using ad-hoc signing for an unsigned local/test Mac build.");
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const result = spawnSync("codesign", [
    "--force",
    "--deep",
    "--sign",
    "-",
    "--timestamp=none",
    appPath,
  ], {
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`Ad-hoc codesign failed for ${appPath}`);
  }
};
