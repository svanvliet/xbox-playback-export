// Review before running manually in your own Xbox Playback tab's DevTools Console.
// This only reads a presentation prop from at most 64 React ancestors.
(() => {
  const route = 'https://assets-xbxweb.xbox.com/xbox-web/static/js/PlaybackVideoPage.5cadca40.chunk.js';
  if (![...document.scripts].some(script => script.src === route)) {
    throw Error('Unsupported Xbox page build; do not dump application state as a workaround.');
  }
  const main = document.querySelector('main[data-experience-completed]');
  const key = main && Object.keys(main).find(name => name.startsWith('__reactFiber$'));
  let fiber = key && main[key];
  let payload;
  for (let depth = 0; fiber && depth < 64; depth++, fiber = fiber.return) {
    const candidate = fiber.memoizedProps?.payload;
    if (candidate && Array.isArray(candidate.chapters) && candidate.commonText && candidate.userInformation) {
      payload = candidate;
      break;
    }
  }
  if (!payload || payload.chapters.map(chapter => chapter.kind).join(',') !== 'Intro,Origin,Outro' ||
      !payload.chapters.every(chapter => Array.isArray(chapter.data?.videoSequence)) ||
      !Array.isArray(payload.chapterCues)) {
    throw Error('Supported presentation payload not found. Open your loaded Playback presentation first.');
  }
  const selected = Object.fromEntries(
    ['chapterCount', 'chapters', 'commonText', 'userInformation', 'playbackMusicUri', 'chapterCues']
      .map(name => [name, payload[name]]));
  const text = JSON.stringify(selected);
  if (text.length > 2 * 1024 * 1024) throw Error('Presentation exceeds the supported size.');
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'xbox-playback-scenes.json';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
})();
