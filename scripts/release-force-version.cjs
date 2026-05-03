// One-off semantic-release plugin that forces nextRelease.version to a fixed
// value. Used a single time to align this SDK's major version with the other
// SDKs (1.10.0 -> 3.0.0, skipping 2.x). Remove this file and its entry in
// .releaserc.json immediately after the forced release publishes.

module.exports = {
  verifyRelease(pluginConfig, context) {
    const target = pluginConfig.version;
    if (!target) return;

    const { logger, nextRelease, options } = context;
    const tagFormat = (options && options.tagFormat) || "v${version}";
    const gitTag = tagFormat.replace("${version}", target);

    logger.log(
      `[force-version] overriding nextRelease ${nextRelease.version} -> ${target}`
    );

    nextRelease.version = target;
    nextRelease.gitTag = gitTag;
    nextRelease.name = gitTag;
  },
};
