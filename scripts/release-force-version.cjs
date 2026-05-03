// Semantic-release plugin that forces nextRelease.version to a fixed value
// when the FORCE_VERSION env var is set (or when pluginConfig.version is set).
//
// Used for one-off corrections such as cross-SDK version alignment. Driven
// via the workflow_dispatch "Force version" input in .github/workflows/ci-cd.yml,
// which plumbs the input as the FORCE_VERSION env var. Leave the input empty
// for the normal semantic-release flow.
//
// The analyzeCommits hook ensures the release lifecycle fires even if there
// are no release-worthy commits since the last tag (otherwise semantic-release
// would short-circuit before verifyRelease could override the version).

function resolveTarget(pluginConfig) {
  return pluginConfig.version || process.env.FORCE_VERSION || null;
}

module.exports = {
  analyzeCommits(pluginConfig, context) {
    const target = resolveTarget(pluginConfig);
    if (target) {
      context.logger.log(
        `[force-version] forcing release because FORCE_VERSION=${target}`
      );
      // Any non-null release type triggers the downstream lifecycle. The
      // verifyRelease hook below replaces the actual version string.
      return "patch";
    }
    return null;
  },

  verifyRelease(pluginConfig, context) {
    const target = resolveTarget(pluginConfig);
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
