#!/usr/bin/env node
// Static site generator with no dependencies. Run from anywhere: node _src/build.mjs
// Reads _src/data/*.json and writes the HTML pages, robots.txt and sitemap.xml to the repo root.
// Every page holds both languages on one URL; the class on <html> decides which one is shown.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SRC, '..');
const readJson = name => JSON.parse(readFileSync(join(SRC, 'data', name), 'utf8'));

const builds = readJson('builds.json');
const ghost = readJson('ghost-spectre.json');
const settings = readJson('settings.json');

const SITE = 'https://somov.org';
const CDN = 'https://dl3.somov.org/';
const GA_ID = 'G-4RBN0G8775';
const TELEGRAM = 'https://t.me/+gmXk9-zXZ405YWY6';
const BTC = '1Bf7A9JZHuDzu7yTzNqEL9q8KHHfgjMZgu';
const LANGS = ['en', 'ru'];

const assetHash = file => createHash('sha1').update(readFileSync(join(ROOT, file))).digest('hex').slice(0, 8);
const CSS_URL = `/assets/site.css?v=${assetHash('assets/site.css')}`;
const JS_URL = `/assets/site.js?v=${assetHash('assets/site.js')}`;

/* -- Helpers ------------------------------------------------------------- */

const esc = value => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Bilingual inline markup from ready HTML strings.
const L = (en, ru) => (en === ru ? en : `<span class="lang-en">${en}</span><span class="lang-ru">${ru}</span>`);

// Bilingual inline markup from a data value; plain strings are language neutral.
const T = value => (value && typeof value === 'object' ? L(esc(value.en), esc(value.ru)) : esc(value));

// An attribute with an English default; site.js switches it to the current language.
const attr = (name, en, ru) =>
  `${name}="${esc(en)}" data-i18n="${esc(JSON.stringify({ [name]: { en, ru } }))}"`;

const formatSize = (bytes, lang) => {
  const gb = (bytes / 2 ** 30).toFixed(1);
  return lang === 'ru' ? `${gb.replace('.', ',')} ГБ` : `${gb} GB`;
};
const sizeL = bytes => L(formatSize(bytes, 'en'), formatSize(bytes, 'ru'));

const PATHS = {
  d: 'M5 12h14m-6-6 6 6-6 6',
  back: 'M19 12H5m6-6-6 6 6 6',
  download: 'M12 4v12m-5-5 5 5 5-5M5 20h14',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  check: 'm5 12 5 5 9-10',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  close: 'M6 6l12 12M18 6 6 18',
  left: 'm15 6-6 6 6 6',
  right: 'm9 6 6 6-6 6',
};
const icon = name => {
  const shape = PATHS[name];
  const body = shape.startsWith('<') ? shape : `<path d="${shape}"/>`;
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
};

/* -- Interface strings --------------------------------------------------- */

const S = {
  home: L('Home', 'На главную'),
  download: L('Download', 'Скачать'),
  downloadIso: L('Download ISO', 'Скачать ISO'),
  english: L('English', 'Английский'),
  russian: L('Russian', 'Русский'),
  final: L('Final', 'Финальная'),
};
const imageLangName = lang => (lang === 'ru' ? S.russian : S.english);

/* -- Layout -------------------------------------------------------------- */

const analytics = `<!-- Owner opt-out: open /?noga to stop counting this device, /?ga to resume -->
<script>
(function(){var ID='${GA_ID}';try{var p=new URLSearchParams(location.search);if(p.has('noga'))localStorage.setItem('ga-optout','1');if(p.has('ga'))localStorage.removeItem('ga-optout');if(localStorage.getItem('ga-optout')==='1')window['ga-disable-'+ID]=true;}catch(e){}})();
</script>
<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>
<script>
window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${GA_ID}');
</script>`;

// Before first paint: use the saved language, otherwise the browser language.
const langScript = `<script>
(function(){var s;try{s=localStorage.getItem('siteLanguage')}catch(e){}var l=s==='ru'||s==='en'?s:((navigator.language||'').toLowerCase().indexOf('ru')===0?'ru':'en');var r=document.documentElement;r.lang=l;r.classList.add('lang-'+l+'-active');if(l==='ru'){if(r.dataset.titleRu)document.title=r.dataset.titleRu;var k=document.createElement('link');k.rel='preload';k.as='font';k.type='font/woff2';k.crossOrigin='';k.href='/assets/fonts/inter-cyrillic-wght-normal.woff2';document.head.appendChild(k);}})();
</script>`;

function head({ path, title, description }) {
  const canonical = `${SITE}${path}`;
  return `<!DOCTYPE html>
<html lang="en" data-title-en="${esc(title.en)}" data-title-ru="${esc(title.ru)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title.en)}</title>
  <meta name="description" content="${esc(description)}">
  <link rel="canonical" href="${canonical}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Windows by somov">
  <meta property="og:title" content="${esc(title.en)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:url" content="${canonical}">
  <meta property="og:image" content="${SITE}/images/og.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="theme-color" content="#0f1115">
  <meta name="color-scheme" content="dark">
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="apple-touch-icon" href="/images/apple-touch-icon.png">
  <link rel="preload" href="/assets/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
  ${langScript}
  ${analytics}
  <link rel="stylesheet" href="${CSS_URL}">
</head>`;
}

function header(current) {
  const navLink = (key, href, label) =>
    `<a href="${href}"${current === key ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<a class="skip-link" href="#content">${L('Skip to content', 'Перейти к содержимому')}</a>
  <header class="topbar">
    <div class="container topbar-inner">
      <a href="/" class="brand">
        <img src="/images/logo-mark.png" alt="" width="32" height="32">
        <span>Windows by somov</span>
      </a>
      <nav class="site-nav" ${attr('aria-label', 'Main', 'Основная навигация')}>
        ${navLink('builds', '/', L('Builds', 'Сборки'))}
        ${navLink('ghost', '/ghost-spectre', 'Ghost Spectre')}
        ${navLink('settings', '/settings-for-windows', L('Settings', 'Настройки'))}
        <a class="nav-external" href="${TELEGRAM}" target="_blank" rel="noopener">Telegram</a>
      </nav>
      <div class="lang-switch" role="group" aria-label="Site language / Язык сайта">
        <button type="button" data-set-lang="en" aria-pressed="false">EN</button>
        <button type="button" data-set-lang="ru" aria-pressed="false">RU</button>
      </div>
    </div>
  </header>`;
}

const footer = `<footer class="footer">
    <div class="container footer-inner">
      <section>
        <h2>${L('Support the project', 'Поддержать проект')}</h2>
        <div class="footer-links">
          <a href="https://ko-fi.com/somov" target="_blank" rel="noopener">${L('Buy me a coffee', 'Купить кофе')}</a>
          <a href="https://yoomoney.ru/to/4100118200965581" target="_blank" rel="noopener">${L('Tips via YooMoney', 'Чаевые через ЮMoney')}</a>
          <button type="button" class="footer-copy" data-copy="${BTC}" ${attr('aria-label', 'Copy BTC address', 'Скопировать адрес BTC')}>BTC <code>1Bf7A...gjMZgu</code> ${icon('copy')}</button>
        </div>
      </section>
      <section>
        <h2>${L('Contact', 'Контакты')}</h2>
        <div class="footer-links">
          <a href="${TELEGRAM}" target="_blank" rel="noopener">Telegram</a>
          <a href="mailto:me@somov.org">me@somov.org</a>
        </div>
      </section>
      <div class="footer-end">&copy; somov.org</div>
    </div>
  </footer>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>
  <script src="${JS_URL}" defer></script>`;

const shell = (meta, current, body, bodyClass = '') => `${head(meta)}
<body${bodyClass ? ` class="${bodyClass}"` : ''}>
  ${header(current)}
  ${body}
  ${footer}
</body>
</html>
`;

function write(relativePath, html) {
  const full = join(ROOT, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, html);
}

/* -- Home ---------------------------------------------------------------- */

const imageFor = (build, imageLang) => {
  const image = build.images[imageLang];
  return {
    ...image,
    url: `${CDN}${image.file}`,
    magnet: `magnet:?xt=urn:btih:${image.btih}&dn=${encodeURIComponent(image.file)}`,
    path: `/windows-${build.id}-${imageLang}`,
  };
};

function homePage() {
  const build = builds[0];
  const image = imageFor(build, 'en');

  const data = Object.fromEntries(builds.map(b => [b.id, {
    title: b.title,
    version: b.version,
    number: b.number,
    date: b.date,
    final: b.final,
    images: Object.fromEntries(LANGS.map(l => {
      const img = imageFor(b, l);
      return [l, {
        url: img.url,
        magnet: img.magnet,
        size: { en: formatSize(img.size, 'en'), ru: formatSize(img.size, 'ru') },
        details: img.path,
      }];
    })),
  }]));

  const radio = (name, value, label, checked) =>
    `<label><input type="radio" name="${name}" value="${value}"${checked ? ' checked' : ''}><span>${label}</span></label>`;

  const body = `<main class="home" id="content">
    <div class="container container-narrow">
      <div class="hero">
        <h1>${L('Which Windows do you want to install?', 'Какую Windows вы хотите установить?')}</h1>
        <p>${L('IoT Enterprise LTSC builds by somov', 'Сборки IoT Enterprise LTSC от somov')}</p>
      </div>

      <section class="composer" aria-labelledby="build-title">
        <div class="selectors">
          <fieldset>
            <legend class="field-label">${L('Version', 'Версия')}</legend>
            <div class="segmented">
              ${builds.map((b, i) => radio('os', b.id, `Windows ${b.id}`, i === 0)).join('\n              ')}
            </div>
          </fieldset>
          <fieldset>
            <legend class="field-label">${L('Image language', 'Язык образа')}</legend>
            <div class="segmented">
              ${radio('image-lang', 'en', S.english, true)}
              ${radio('image-lang', 'ru', S.russian, false)}
            </div>
          </fieldset>
        </div>

        <div class="result">
          <div>
            <h2 id="build-title">${esc(build.title)}</h2>
            <div class="meta">
              <span id="build-version">${build.version}</span>
              <span aria-hidden="true">·</span>
              <span class="mono" id="build-number">${build.number}</span>
              <span aria-hidden="true">·</span>
              <span><span class="lang-en" id="build-date-en">${build.date.en}</span><span class="lang-ru" id="build-date-ru">${build.date.ru}</span></span>
              <span class="badge" id="build-final" hidden>${S.final}</span>
            </div>
            <a class="details-link" id="details-link" href="${image.path}">
              ${L('Build details', 'Подробнее о сборке')} ${icon('d')}
            </a>
          </div>
          <div class="dl-actions">
            <a class="btn btn-primary btn-block" id="download-link" href="${image.url}">
              ${icon('download')} <span>${S.downloadIso} · <span class="lang-en" id="download-size-en">${formatSize(image.size, 'en')}</span><span class="lang-ru" id="download-size-ru">${formatSize(image.size, 'ru')}</span></span>
            </a>
            <div class="dl-alt">
              <a class="btn btn-secondary btn-sm" id="torrent-link" href="${image.url}.torrent">Torrent</a>
              <a class="btn btn-secondary btn-sm" id="magnet-link" href="${esc(image.magnet)}">Magnet</a>
            </div>
          </div>
        </div>
      </section>

      <noscript>
        <p class="noscript-links">
          ${builds.flatMap(b => LANGS.map(l => `<a class="link" href="/windows-${b.id}-${l}">Windows ${b.id} (${l === 'ru' ? 'Russian' : 'English'})</a>`)).join(' · ')}
        </p>
      </noscript>

      <nav class="more" ${attr('aria-label', 'More', 'Ещё')}>
        <a class="more-card" href="/ghost-spectre">
          <span>
            <span class="more-card-title">${L('Ghost Spectre builds', 'Сборки Ghost Spectre')}</span>
            <span class="more-card-sub">${L('Windows 10/11 · by Ghost Spectre', 'Windows 10/11 · автор Ghost Spectre')}</span>
          </span>
          ${icon('d')}
        </a>
        <a class="more-card" href="/settings-for-windows">
          <span>
            <span class="more-card-title">${L('Settings for Windows', 'Настройки для Windows')}</span>
            <span class="more-card-sub">${L('Tools, tweaks and guides', 'Утилиты, твики и инструкции')}</span>
          </span>
          ${icon('d')}
        </a>
      </nav>
    </div>
  </main>
  <script type="application/json" id="builds-data">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;

  write('index.html', shell({
    path: '/',
    title: { en: 'Windows by somov: IoT Enterprise LTSC builds', ru: 'Windows от somov: сборки IoT Enterprise LTSC' },
    description: 'Windows 11 and Windows 10 IoT Enterprise LTSC builds by somov in English and Russian. Direct download, torrent and magnet.',
  }, 'builds', body));
}

/* -- Build page ---------------------------------------------------------- */

const SHOT_ALT = {
  en: ['Registry Editor window', 'File Explorer and drive properties', 'Settings: About', 'Task Manager: Performance', 'About Windows dialog', 'Settings: Installed apps'],
  ru: ['Окно редактора реестра', 'Проводник и свойства диска', 'Параметры: О системе', 'Диспетчер задач: Производительность', 'Окно «О программе Windows»', 'Параметры: Установленные приложения'],
};

// The first screenshot is shown large: the desktop with the About Windows dialog reads best.
const SHOT_ORDER = [5, 2, 3, 4, 1, 6];

function gallery(build, imageLang) {
  const [w, h] = build.ratio;
  const dir = `/images/windows-${build.id}-${imageLang}`;
  return SHOT_ORDER.map((n, index) => {
    const sizes = index === 0 ? '(min-width: 1024px) 720px, 100vw' : '(min-width: 1024px) 140px, 33vw';
    const srcset = [480, 960, 1600].map(x => `${dir}/${n}-${x}.webp ${x}w`).join(', ');
    return `<a class="shot" href="${dir}/${n}-1600.webp"><img src="${dir}/${n}-${index === 0 ? 960 : 480}.webp" srcset="${srcset}" sizes="${sizes}" width="${w}" height="${h}" ${attr('alt', SHOT_ALT.en[n - 1], SHOT_ALT.ru[n - 1])} loading="lazy" decoding="async"></a>`;
  }).join('\n          ');
}

function buildPage(build, imageLang) {
  const image = imageFor(build, imageLang);
  const otherImage = imageLang === 'ru' ? 'en' : 'ru';
  const size = sizeL(image.size);

  const sums = [
    ['SHA-256', image.sums.sha256], ['SHA-1', image.sums.sha1], ['MD5', image.sums.md5], ['CRC32', image.sums.crc32],
  ].filter(([, value]) => value);

  const body = `<main class="page" id="content">
    <div class="container build">
      <div class="build-head">
        <a href="/" class="back">${icon('back')} ${S.home}</a>
        <h1 class="page-title">${esc(build.title)}</h1>
        <div class="meta">
          <span>${build.version}</span>
          <span aria-hidden="true">·</span>
          <span class="mono">${build.number}</span>
          <span aria-hidden="true">·</span>
          <span>${T(build.date)}</span>
          <span class="badge">${imageLangName(imageLang)}</span>
          ${build.final ? `<span class="badge">${S.final}</span>` : ''}
        </div>
        <p class="lead">${T(build.lead)}</p>
      </div>

      <aside class="build-panel" ${attr('aria-label', 'Download', 'Скачать')}>
        <div class="panel">
          <div class="panel-title">${esc(build.title)}</div>
          <dl class="panel-rows">
            <div><dt>${L('Size', 'Размер')}</dt><dd>${size}</dd></div>
            <div><dt>${L('Image language', 'Язык образа')}</dt><dd>${imageLangName(imageLang)}</dd></div>
            <div><dt>${L('Format', 'Формат')}</dt><dd>ISO · x64</dd></div>
          </dl>
          <div class="dl-actions">
            <a class="btn btn-primary btn-block" href="${image.url}">${icon('download')} <span>${S.downloadIso}</span></a>
            <div class="dl-alt">
              <a class="btn btn-secondary btn-sm" href="${image.url}.torrent">Torrent</a>
              <a class="btn btn-secondary btn-sm" href="${esc(image.magnet)}">Magnet</a>
            </div>
          </div>
          <a class="panel-other link" href="/windows-${build.id}-${otherImage}">${L('Image in another language', 'Образ на другом языке')}: ${imageLangName(otherImage)}</a>
        </div>
      </aside>

      <div class="build-body">
        <section class="section">
          <h2>${L('What’s changed', 'Что изменено')}</h2>
          <ul class="check-list">
            ${build.changes.map(c => `<li>${icon('check')}<span>${T(c)}</span></li>`).join('\n            ')}
          </ul>
        </section>

        <section class="section">
          <h2>${L('Screenshots', 'Скриншоты')}</h2>
          <div class="gallery">
          ${gallery(build, imageLang)}
          </div>
        </section>

        <section class="section">
          <h2>${L('How to install', 'Как установить')}</h2>
          <ol class="steps">
            <li><span>${L('Download the ISO and verify its checksum.', 'Скачайте ISO и проверьте контрольную сумму.')}</span></li>
            <li><span>${L('Back up your important files: installation can erase the disk.', 'Сохраните важные файлы: установка может стереть диск.')}</span></li>
            <li><span>${L('Write the ISO to a USB drive of 8 GB or more, for example with', 'Запишите ISO на флешку от 8 ГБ, например с помощью')} <a class="link" href="https://rufus.ie/" target="_blank" rel="noopener">Rufus</a>.</span></li>
            <li><span>${L('Boot from the USB drive and follow the installer.', 'Загрузитесь с флешки и следуйте шагам установщика.')}</span></li>
          </ol>
        </section>

        <section class="section">
          <h2>${L('System requirements', 'Системные требования')}</h2>
          <dl class="req">
            ${build.requirements.map(r => `<div><dt>${T(r.label)}</dt><dd>${T(r.value)}</dd></div>`).join('\n            ')}
          </dl>
        </section>

        <section class="section">
          <h2>${L('Checksums', 'Контрольные суммы')}</h2>
          <div class="sums">
            ${sums.map(([label, value]) => `<div class="sum-row">
              <span class="sum-label">${label}</span>
              <span class="sum-val">${value}</span>
              <button type="button" class="icon-btn" data-copy="${value}" ${attr('aria-label', `Copy ${label}`, `Скопировать ${label}`)}>${icon('copy')}</button>
            </div>`).join('\n            ')}
          </div>
          <p class="sums-file">${esc(image.file)}</p>
        </section>

        ${build.history.length > 1 ? `<section class="section">
          <h2>${L('Version history', 'История версий')}</h2>
          <ul class="history">
            ${build.history.map(h => `<li><span class="mono">${h.number}</span><span>${T(h.date)}</span></li>`).join('\n            ')}
          </ul>
        </section>` : ''}
      </div>
    </div>
  </main>

  <div class="dl-bar" hidden>
    <a class="btn btn-primary btn-block" href="${image.url}">${icon('download')} <span>${S.downloadIso} · ${size}</span></a>
  </div>

  <dialog class="lightbox" id="lightbox" ${attr('aria-label', 'Screenshot', 'Скриншот')}>
    <img src="data:," alt="">
    <button type="button" class="lb-btn lb-close" ${attr('aria-label', 'Close', 'Закрыть')}>${icon('close')}</button>
    <button type="button" class="lb-btn lb-prev" ${attr('aria-label', 'Previous', 'Предыдущий')}>${icon('left')}</button>
    <button type="button" class="lb-btn lb-next" ${attr('aria-label', 'Next', 'Следующий')}>${icon('right')}</button>
    <div class="lb-count"></div>
  </dialog>`;

  const tag = imageLang.toUpperCase();
  write(`windows-${build.id}-${imageLang}.html`, shell({
    path: image.path,
    title: {
      en: `${build.title} [${tag}] - Windows by somov`,
      ru: `${build.title} [${tag}] - Windows от somov`,
    },
    description: `${build.title} ${build.version}, build ${build.number}, ${imageLang === 'ru' ? 'Russian' : 'English'} image, ${formatSize(image.size, 'en')}. Direct download, torrent, magnet and checksums.`,
  }, 'builds', body, 'has-dl-bar'));
}

/* -- Ghost Spectre ------------------------------------------------------- */

function ghostPage() {
  const row = item => {
    const url = `${CDN}${item.file}`;
    return `<article class="row${item.muted ? ' row-muted' : ''}">
          <div>
            <h3 class="row-name">${esc(item.name)} ${item.version}</h3>
            <div class="meta">
              <span class="mono">${item.number}</span>
              <span aria-hidden="true">·</span>
              <span>${T(item.date)}</span>
              <span aria-hidden="true">·</span>
              <span>${sizeL(item.size)}</span>
              ${item.status ? `<span class="badge">${T(item.status)}</span>` : ''}
            </div>
          </div>
          <div class="row-actions">
            <a class="btn btn-secondary btn-sm" href="${url}">${icon('download')} <span>${S.download}</span></a>
            <a class="row-text-link" href="${url}.torrent">Torrent</a>
          </div>
        </article>`;
  };

  const body = `<main class="page" id="content">
    <div class="container container-narrow">
      <a href="/" class="back">${icon('back')} ${S.home}</a>
      <h1 class="page-title">${L('Ghost Spectre builds', 'Сборки Ghost Spectre')}</h1>
      <p class="page-sub">${L('Windows 10/11 · by Ghost Spectre', 'Windows 10/11 · автор Ghost Spectre')}</p>
      <div class="section">
        ${ghost.groups.map(group => `<section class="group">
        <h2 class="group-title">${group.title}</h2>
        <div class="rows">
        ${group.items.map(row).join('\n        ')}
        </div>
        </section>`).join('\n        ')}
      </div>
      <p class="note">${L('Author’s YouTube channel:', 'YouTube-канал автора:')} <a class="link" href="${ghost.youtube}" target="_blank" rel="noopener">youtube.com/@GHOSTSPECTRE</a></p>
    </div>
  </main>`;

  write('ghost-spectre.html', shell({
    path: '/ghost-spectre',
    title: { en: 'Ghost Spectre - Windows by somov', ru: 'Ghost Spectre - Windows от somov' },
    description: 'Windows 10 and Windows 11 builds by Ghost Spectre: versions, dates and sizes. Direct download and torrent.',
  }, 'ghost', body));
}

/* -- Settings ------------------------------------------------------------ */

function settingsPage() {
  const TAGS = {
    admin: L('Run as administrator', 'Нужны права администратора'),
    reboot: L('Restart required', 'Нужна перезагрузка'),
  };

  const fileType = file => decodeURIComponent(file).match(/\.[a-z0-9]+$/i)?.[0].toLowerCase() ?? '';

  // Both languages are searchable, whichever one is on screen.
  const plain = value => (value && typeof value === 'object' ? Object.values(value) : [value]);

  // A link may exist in one language only, or point to a different URL per language.
  const linkHtml = link => {
    const labelFor = lang => (typeof link.label === 'object' ? link.label[lang] : link.label);
    const urlFor = lang => (typeof link.url === 'object' ? link.url[lang] : link.url);
    if (labelFor('en') && labelFor('ru') && urlFor('en') === urlFor('ru')) {
      return `<a class="link" href="${esc(urlFor('en'))}" target="_blank" rel="noopener">${T(link.label)}</a>`;
    }
    return LANGS.filter(labelFor).map(lang =>
      `<a class="link lang-${lang}" href="${esc(urlFor(lang))}" target="_blank" rel="noopener">${esc(labelFor(lang))}</a>`).join('');
  };

  const itemHtml = item => {
    const searchText = [
      ...plain(item.title), ...plain(item.desc), item.file ? decodeURIComponent(item.file) : '',
      ...(item.commands ?? []).flatMap(c => [...plain(c.label), c.code]),
      ...(item.downloads ?? []).map(d => d.label),
      ...(item.keys ?? []).flatMap(k => [...plain(k.combo), ...plain(k.desc)]),
      ...(item.links ?? []).flatMap(link => plain(link.label)),
    ].filter(Boolean).join(' ').toLowerCase();

    const hasAction = Boolean(item.file);
    return `<article class="item" id="${item.id}" data-category="${item.category}" data-search="${esc(searchText)}">
          <div${hasAction ? '' : ' class="item-full"'}>
            <h3 class="item-title"><a href="#${item.id}">${T(item.title)}</a></h3>
            ${item.desc ? `<p class="item-desc">${T(item.desc)}</p>` : ''}
            ${item.tags?.length ? `<div class="item-tags">${item.tags.map(tag => `<span class="badge">${TAGS[tag]}</span>`).join('')}</div>` : ''}
            ${item.links?.length ? `<div class="item-links">${item.links.map(linkHtml).join('')}</div>` : ''}
            ${item.commands ? `<div class="commands">${item.commands.map(c => `<div>
              <div class="command-label">${T(c.label)}</div>
              <div class="command"><code>${esc(c.code)}</code><button type="button" class="icon-btn" data-copy="${esc(c.code)}" ${attr('aria-label', 'Copy command', 'Скопировать команду')}>${icon('copy')}</button></div>
            </div>`).join('')}</div>` : ''}
            ${item.downloads ? `<div class="chip-links">${item.downloads.map(d => `<a class="btn btn-secondary btn-sm" href="${CDN}${d.file}">${icon('download')} ${esc(d.label)}</a>`).join('')}</div>` : ''}
            ${item.keys ? `<dl class="keys">${item.keys.map(k => `<div><dt>${T(k.combo)}</dt><dd>${T(k.desc)}</dd></div>`).join('')}</dl>` : ''}
          </div>
          ${hasAction ? `<div class="item-action">
            <span class="file-type">${fileType(item.file)}</span>
            <a class="btn btn-secondary btn-sm" href="${CDN}${item.file}">${icon('download')} <span>${S.download}</span></a>
          </div>` : ''}
        </article>`;
  };

  const body = `<main class="page" id="content">
    <div class="container container-narrow">
      <a href="/" class="back">${icon('back')} ${S.home}</a>
      <h1 class="page-title">${L('Settings for Windows', 'Настройки для Windows')}</h1>
      <p class="page-sub">${L('Tools, tweaks and guides', 'Утилиты, твики и инструкции')}</p>

      <div class="toolbar">
        <label class="search">
          <span class="sr-only">${L('Search', 'Поиск')}</span>
          ${icon('search')}
          <input type="search" id="settings-search" ${attr('placeholder', 'Search: telemetry, drivers, Store…', 'Поиск: телеметрия, драйверы, Store…')} autocomplete="off">
        </label>
        <div class="chips" role="group" ${attr('aria-label', 'Categories', 'Категории')}>
          <button type="button" class="chip" data-category="all" aria-pressed="true">${L('All', 'Все')}</button>
          ${settings.categories.map(c => `<button type="button" class="chip" data-category="${c.id}" aria-pressed="false">${T(c.title)}</button>`).join('\n          ')}
        </div>
      </div>

      <p class="result-count" id="result-count" role="status"></p>
      <p class="empty" id="empty" hidden>${L('Nothing found. Try another word or category.', 'Ничего не найдено. Попробуйте другое слово или категорию.')}</p>

      ${settings.categories.map(c => `<section class="section group" data-group="${c.id}">
        <h2 class="group-title">${T(c.title)}</h2>
        <div class="rows">
        ${settings.items.filter(i => i.category === c.id).map(itemHtml).join('\n        ')}
        </div>
      </section>`).join('\n      ')}
    </div>
  </main>`;

  write('settings-for-windows.html', shell({
    path: '/settings-for-windows',
    title: { en: 'Settings for Windows - Windows by somov', ru: 'Настройки для Windows - Windows от somov' },
    description: 'Windows tweaks, drivers, PowerShell commands and useful tools, with search and categories.',
  }, 'settings', body));
}

/* -- 404 ----------------------------------------------------------------- */

function notFoundPage() {
  write('404.html', `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>404 - Windows by somov</title>
  <meta name="robots" content="noindex">
  <meta name="theme-color" content="#0f1115">
  <meta name="color-scheme" content="dark">
  <link rel="icon" href="/favicon.ico" sizes="any">
  ${langScript}
  <link rel="stylesheet" href="${CSS_URL}">
</head>
<body>
  <main class="not-found" id="content">
    <div class="not-found-code">404</div>
    <p>${L('This page doesn’t exist.', 'Такой страницы не существует.')}</p>
    <a class="btn btn-primary" href="/">${icon('back')} <span>${L('Back to home', 'На главную')}</span></a>
  </main>
</body>
</html>
`);
}

/* -- Robots and sitemap -------------------------------------------------- */

function sitemap() {
  const paths = ['/', '/ghost-spectre', '/settings-for-windows',
    ...builds.flatMap(b => LANGS.map(l => `/windows-${b.id}-${l}`))];
  write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths.map(path => `  <url><loc>${SITE}${path}</loc></url>`).join('\n')}
</urlset>
`);
  write('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
}

/* -- Run ----------------------------------------------------------------- */

for (const build of builds) {
  for (const imageLang of LANGS) {
    for (const n of SHOT_ORDER) {
      const shot = join(ROOT, `images/windows-${build.id}-${imageLang}/${n}-1600.webp`);
      if (!existsSync(shot)) throw new Error(`Missing screenshot: ${shot}. Run: python _src/images.py`);
    }
  }
}

homePage();
ghostPage();
settingsPage();
for (const build of builds) {
  for (const imageLang of LANGS) buildPage(build, imageLang);
}
notFoundPage();
sitemap();
console.log('Site built.');
