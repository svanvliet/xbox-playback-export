// Evaluate this function only in the user's selected, consented Playback tab.
// Returns bounded presentation JSON text, or initiates a Blob download.
({ download = false } = {}) => {
  const fail = code => { throw Error(code); };
  const locationUrl = new URL(location.href);
  if (locationUrl.origin !== 'https://www.xbox.com' || locationUrl.username || locationUrl.password ||
      !/^\/(?:[a-z]{2}-[a-z]{2}\/)?(?:xboxplayback|playback)(?:\/|$)/i.test(locationUrl.pathname)) {
    fail('PLAYBACK_WRONG_PAGE');
  }
  const main = document.querySelector('main[data-experience-completed]');
  if (!main) fail('PLAYBACK_NOT_READY');
  const route = 'https://assets-xbxweb.xbox.com/xbox-web/static/js/PlaybackVideoPage.5cadca40.chunk.js';
  if (![...document.scripts].some(script => script.src === route)) fail('PLAYBACK_UNSUPPORTED_BUILD');
  const key = Object.keys(main).find(name => name.startsWith('__reactFiber$'));
  let fiber = key && Object.getOwnPropertyDescriptor(main, key)?.value;
  let payload;
  for (let depth = 0; fiber && depth < 64; depth++, fiber = fiber.return) {
    const candidate = fiber.memoizedProps?.payload;
    if (candidate && Array.isArray(candidate.chapters)) { payload = candidate; break; }
  }
  if (!payload) fail('PLAYBACK_NOT_READY');

  // Explicit nested allowlists prevent extra auth/store fields or toJSON hooks
  // from being serialized, even when attached to a valid presentation object.
  let nodes = 0;
  let bytes = 0;
  const value = (object, key) => {
    if (!object || typeof object !== 'object') fail('PLAYBACK_INVALID_DATA');
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor && !Object.hasOwn(descriptor, 'value')) fail('PLAYBACK_INVALID_DATA');
    return descriptor?.value;
  };
  const pick = (object, fields) => {
    const result = {};
    for (const key of fields.split(' ')) {
      if (++nodes > 20000) fail('PLAYBACK_INVALID_DATA');
      const item = value(object, key);
      if (item === undefined) continue;
      if (item !== null && !['string', 'number', 'boolean'].includes(typeof item) ||
          typeof item === 'string' && item.length > 100000 ||
          typeof item === 'number' && !Number.isFinite(item)) fail('PLAYBACK_INVALID_DATA');
      if (typeof item === 'string') {
        bytes += new TextEncoder().encode(item).length;
        if (bytes > 2 * 1024 * 1024) fail('PLAYBACK_INVALID_DATA');
      }
      result[key] = item;
    }
    return result;
  };
  const list = (items, mapper) => {
    if (!Array.isArray(items) || items.length > 1000) fail('PLAYBACK_INVALID_DATA');
    return Array.from({ length: items.length }, (_, i) => mapper(value(items, String(i))));
  };
  const game = item => pick(item, 'gameName gameBoxArtUri gameImageUri timePlayedMinutes gamerscore');
  const fields = {
    Intro: 'playerLocatedText yourPlaybackIsReadyText achievementsLoading',
    Origin: 'letsPlayItBackText xboxMasterText yearJoined firstConsoleName firstConsoleBootVideoUri firstConsoleImageUri beforeAchievementsText youWereHereText firstConsoleText yourFirstGameText justGettingStartedText sinceThenYouveSpentText perfectingYourGameText timePlayedSinceStartedMinutes mostPlayedGameText peakPerformanceText topAchievementText mostTimePlayedText topGamerscoreText longestStreakText startStreakDate endStreakDate youPlayedYourWayText topPercentOfHoursPlayedText topPercentage topAchievementsYear topTimePlayedYear topGamerscoreYear topAchievementsCount topTimePlayedCount topGamerscoreCount',
    Outro: 'for25YearsText playersLikeYouText heresToTheNext25Text openYourArchiveText shareYourMemoriesText shareUri',
  };
  const selected = pick(payload, 'chapterCount');
  selected.chapters = list(value(payload, 'chapters'), chapter => {
    const result = pick(chapter, 'kind title');
    if (!Object.hasOwn(fields, result.kind)) fail('PLAYBACK_INVALID_DATA');
    const data = value(chapter, 'data');
    result.data = pick(data, fields[result.kind]);
    result.data.videoSequence = list(value(data, 'videoSequence'), scene =>
      pick(scene, 'kind backgroundVideoUri requiresUserInteraction loopingVideo'));
    if (result.kind === 'Origin') {
      if (value(data, 'yourFirstGame') !== undefined) result.data.yourFirstGame = game(value(data, 'yourFirstGame'));
      if (value(data, 'topGamesData') !== undefined) result.data.topGamesData = list(value(data, 'topGamesData'), game);
    }
    return result;
  });
  if (selected.chapterCount !== 3 || selected.chapters.map(c => c.kind).join(',') !== 'Intro,Origin,Outro') {
    fail('PLAYBACK_INVALID_DATA');
  }
  const common = value(payload, 'commonText');
  selected.commonText = pick(common, 'enterText continueText gameBoxArtAltText gameImageAltText consoleImageAltText qrCodeAltText rewatchText exitText shareUrlText hoursText hourText minutesText minuteText hoursPlayedText hourPlayedText minutesPlayedText minutePlayedText gamerscoreText daysText dayText gamerPicAltText pauseText rewindText skipAheadText loadingText');
  if (value(common, 'additionalTextStrings') !== undefined) {
    selected.commonText.additionalTextStrings = list(value(common, 'additionalTextStrings'), item => pick(item, 'kind text'));
  }
  selected.userInformation = pick(value(payload, 'userInformation'), 'gamerTag gamerPicUri gamerScore');
  selected.chapterCues = list(value(payload, 'chapterCues'), chapter => ({
    ...pick(chapter, 'chapter'),
    cues: list(value(chapter, 'cues'), cue => pick(cue,
      'key startSeconds endSeconds transitionIn transitionInMs transitionInDistance transitionInScale transitionOut transitionOutMs transitionOutDistance transitionOutScale scene zIndex')),
  }));
  const text = JSON.stringify(selected);
  if (new TextEncoder().encode(text).length > 2 * 1024 * 1024) fail('PLAYBACK_INVALID_DATA');
  if (!download) return text;
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'xbox-playback-scenes.json';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'Presentation download started.';
}
