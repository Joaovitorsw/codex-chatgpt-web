const tls = require("node:tls");

function windowsTrustEnvironment(environment, platform = process.platform) {
  const result = { ...environment };
  if (platform === "win32" && !Object.keys(result).some(key => key.toUpperCase() === "NODE_USE_SYSTEM_CA")) {
    result.NODE_USE_SYSTEM_CA = "1";
  }
  return result;
}

function configureWindowsTrust(platform = process.platform, environment = process.env, certificates = tls) {
  if (platform !== "win32") return;
  const configured = Object.entries(environment).find(([key]) => key.toUpperCase() === "NODE_USE_SYSTEM_CA")?.[1];
  if (configured !== undefined && configured !== "1") return;
  if (configured === undefined) environment.NODE_USE_SYSTEM_CA = "1";
  certificates.setDefaultCACertificates([
    ...certificates.getCACertificates("default"),
    ...certificates.getCACertificates("system"),
  ]);
}

module.exports = { configureWindowsTrust, windowsTrustEnvironment };
