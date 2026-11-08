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
const featured = readJson('featured.json'); // the card at the top of /settings-for-windows

const SITE = 'https://somov.org';
const CDN = 'https://dl3.somov.org/';
const GA_ID = 'G-4RBN0G8775';
const TELEGRAM = 'https://t.me/+gmXk9-zXZ405YWY6';
// Donation methods for /support. QR codes come from _src/qr.py, keep the addresses in sync.
const DONATE = {
  patreon: '', // the Patreon page URL; the card appears on /support once it is set
  yoomoney: 'https://yoomoney.ru/to/4100118200965581',
  tribute: 'https://web.tribute.tg/d/TNH', // donations by bank card from any country; '' hides the card
};
// Crypto on /support. The first network of a coin is its default. `qr` names images/qr-<qr>.svg from _src/qr.py.
const EVM = '0x2842428a11e5c7e7b990e80adf019d7b40e57b9b';
const CRYPTO = [
  { id: 'usdt', name: 'USDT', title: 'Tether', networks: [
    { id: 'trc20', label: 'TRC20', network: 'TRON (TRC20)', address: 'TV38U42SqsUZZKhkoqHtqDyzFrZU4eJsoW', qr: 'tron' },
    { id: 'bep20', label: 'BEP20', network: 'BNB Smart Chain (BEP20)', address: EVM, qr: 'evm' },
    { id: 'ton', label: 'TON', network: 'TON', address: 'UQBFhtxcW-nCZ345ZteeNFN-KBAes5Qk0dcmnH9JGiXxuHlI', qr: 'ton' },
    { id: 'erc20', label: 'ERC20', network: 'Ethereum (ERC20)', address: EVM, qr: 'evm' },
  ] },
  { id: 'usdc', name: 'USDC', title: 'USD Coin', networks: [
    { id: 'erc20', label: 'ERC20', network: 'Ethereum (ERC20)', address: EVM, qr: 'evm' },
    { id: 'sol', network: 'Solana', address: 'CDiaQtzZmhANXHGUmvg2RJKFtim212jWeey6JKxyQyEM', qr: 'sol' },
    { id: 'base', network: 'Base Mainnet', address: EVM, qr: 'evm' },
    { id: 'polygon', network: 'Polygon PoS', address: EVM, qr: 'evm' },
  ] },
  { id: 'btc', name: 'BTC', title: 'Bitcoin', networks: [
    { id: 'btc', network: 'Bitcoin', address: '1Bf7A9JZHuDzu7yTzNqEL9q8KHHfgjMZgu', qr: 'btc' },
  ] },
  { id: 'eth', name: 'ETH', title: 'Ethereum', networks: [
    { id: 'erc20', label: 'ERC20', network: 'Ethereum (ERC20)', address: EVM, qr: 'evm' },
    { id: 'bep20', label: 'BEP20', network: 'BNB Smart Chain (BEP20)', address: EVM, qr: 'evm' },
    { id: 'arbitrum', network: 'Arbitrum One', address: EVM, qr: 'evm' },
  ] },
  { id: 'ltc', name: 'LTC', title: 'Litecoin', networks: [
    { id: 'ltc', network: 'Litecoin', address: 'LU6zxeQq8atUEDW7Q4rBQZRPofMB64SRMj', qr: 'ltc' },
  ] },
  { id: 'doge', name: 'DOGE', title: 'Dogecoin', networks: [
    { id: 'doge', network: 'Dogecoin', address: 'D7YJ6E4M7H6pPXWQXJT5ubaw35ZqbmW4dA', qr: 'doge' },
  ] },
];
const LANGS = ['en', 'ru'];
const TRACKERS = [
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.stealth.si:80/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://tracker.theoks.net:6969/announce',
];

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

// Download click counter: buttons report clicks, the stats line is filled in only for the owner's IP.
const countAttr = (file, kind) => `data-count-file="${esc(file)}" data-count-kind="${kind}"`;
const supportNudge = `<p class="support-nudge">${L('The builds are free. If they helped you, you can <a class="link" href="/support">support the project</a>.', 'Сборки бесплатные. Если пригодились, можно <a class="link" href="/support">поддержать проект</a>.')}</p>`;
const statsLine = (file, kinds = 'download,torrent,magnet') =>
  `<p class="stats-line" data-stats-file="${esc(file)}" data-stats-kinds="${kinds}" hidden></p>`;

const PATHS = {
  d: 'M5 12h14m-6-6 6 6-6 6',
  back: 'M19 12H5m6-6-6 6 6 6',
  download: 'M12 4v12m-5-5 5 5 5-5M5 20h14',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  check: 'm5 12 5 5 9-10',
  send: 'M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z',
  link: 'M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5',
  share: 'M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13',
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

// The owner is not counted in Analytics: on a device opened with /?noga (/?ga undoes it), and from the IPs
// in OWNER_IPS of the download counter. The page view is sent once the counter has answered that this is
// not the owner's IP; window.siteOwner holds that answer for site.js too.
const COUNTER_API = 'https://dl3.somov.org/api';
const analytics = `<!-- Owner opt-out: open /?noga to stop counting this device, /?ga to resume. The owner's IPs are set on the counter. -->
<script>
(function(){var ID='${GA_ID}';try{var p=new URLSearchParams(location.search);if(p.has('noga'))localStorage.setItem('ga-optout','1');if(p.has('ga'))localStorage.removeItem('ga-optout');if(localStorage.getItem('ga-optout')==='1')window['ga-disable-'+ID]=true;}catch(e){}
window.siteOwner=window.fetch?fetch('${COUNTER_API}/stats').then(function(r){return r.json()}).catch(function(){return{owner:false}}):Promise.resolve({owner:false});
window.dataLayer=window.dataLayer||[];window.gtag=function(){dataLayer.push(arguments);};gtag('js',new Date());gtag('config',ID,{send_page_view:false});
window.siteOwner.then(function(d){if(d&&d.owner)window['ga-disable-'+ID]=true;});
Promise.race([window.siteOwner,new Promise(function(r){setTimeout(function(){r({owner:false})},2500)})]).then(function(d){if(!(d&&d.owner))gtag('event','page_view');});})();
</script>
<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>`;

// Before first paint: use the saved language, otherwise the page language (/ru copies are Russian),
// otherwise the browser language. Visitors of a /ru copy keep the usual address: the prefix is removed
// from the address bar without reloading, and Russian is remembered for the rest of the site.
const langScript = `<script>
(function(){var r=document.documentElement,p=location.pathname,s;try{s=localStorage.getItem('siteLanguage')}catch(e){}if(/^\\/ru(\\/|$)/.test(p)){if(!s){s='ru';try{localStorage.setItem('siteLanguage','ru')}catch(e){}}history.replaceState(null,'',(p.replace(/^\\/ru/,'')||'/')+location.search+location.hash)}var l=s==='ru'||s==='en'?s:(r.lang==='ru'||(navigator.language||'').toLowerCase().indexOf('ru')===0?'ru':'en');r.lang=l;r.classList.remove('lang-en-active','lang-ru-active');r.classList.add('lang-'+l+'-active');if(l==='ru'){if(r.dataset.titleRu)document.title=r.dataset.titleRu;var k=document.createElement('link');k.rel='preload';k.as='font';k.type='font/woff2';k.crossOrigin='';k.href='/assets/fonts/inter-cyrillic-wght-normal.woff2';document.head.appendChild(k);}})();
</script>`;

// Build pages: which image language to show before first paint. An explicit URL (-en/-ru) wins,
// otherwise the image follows the site language.
const imageScript = preset => (preset === undefined ? '' : `<script>
document.documentElement.dataset.image=${preset ? `'${preset}'` : "document.documentElement.lang==='ru'?'ru':'en'"};
</script>`);

let PAGE_LANG = 'en';
const langPath = (lang, path) => (lang === 'ru' ? (path === '/' ? '/ru/' : `/ru${path}`) : path);

function head({ path, title, description, imageDefault }) {
  const lang = PAGE_LANG;
  const canonical = `${SITE}${langPath(lang, path)}`;
  const staticImage = imageDefault === undefined ? '' : (imageDefault || (lang === 'ru' ? 'ru' : ''));
  return `<!DOCTYPE html>
<html lang="${lang}"${lang === 'ru' ? ' class="lang-ru-active"' : ''}${staticImage ? ` data-image="${staticImage}"` : ''} data-title-en="${esc(title.en)}" data-title-ru="${esc(title.ru)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title[lang])}</title>
  <meta name="description" content="${esc(description[lang])}">
  <link rel="canonical" href="${canonical}">
  <link rel="alternate" hreflang="en" href="${SITE}${langPath('en', path)}">
  <link rel="alternate" hreflang="ru" href="${SITE}${langPath('ru', path)}">
  <link rel="alternate" hreflang="x-default" href="${SITE}${langPath('en', path)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Windows by somov">
  <meta property="og:title" content="${esc(title[lang])}">
  <meta property="og:description" content="${esc(description[lang])}">
  <meta property="og:url" content="${canonical}">
  <meta property="og:locale" content="${lang === 'ru' ? 'ru_RU' : 'en_US'}">
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
  ${imageScript(imageDefault)}
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
        <a class="nav-external" href="${TELEGRAM}" target="_blank" rel="noopener" data-tg-placement="header">Telegram</a>
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
          <a href="/support">${L('Ways to support', 'Способы поддержки')} ${icon('d')}</a>
        </div>
      </section>
      <section>
        <h2>${L('Contact', 'Контакты')}</h2>
        <div class="footer-links">
          <a href="${TELEGRAM}" target="_blank" rel="noopener" data-tg-placement="footer">Telegram</a>
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
  const full = join(ROOT, PAGE_LANG === 'ru' ? `ru/${relativePath}` : relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, html);
}

/* -- Home ---------------------------------------------------------------- */

const imageFor = (build, imageLang) => {
  const image = build.images[imageLang];
  return {
    ...image,
    url: `${CDN}${image.file}`,
    magnet: `magnet:?xt=urn:btih:${image.btih}&dn=${encodeURIComponent(image.file)}${TRACKERS.map(t => `&tr=${encodeURIComponent(t)}`).join('')}`,
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
        file: img.file,
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
              ${radio('image-lang', 'en', S.english, PAGE_LANG === 'en')}
              ${radio('image-lang', 'ru', S.russian, PAGE_LANG === 'ru')}
            </div>
          </fieldset>
        </div>

        <div class="result">
          <div>
            <h2><a id="build-title" href="${image.path}" tabindex="-1">${esc(build.title)}</a></h2>
            <div class="meta">
              <span class="author">${L('Author:', 'Автор:')} <b>somov</b></span>
              <span id="build-version">${build.version}</span>
              <span aria-hidden="true">·</span>
              <span class="mono" id="build-number">${build.number}</span>
              <span aria-hidden="true">·</span>
              <span><span class="lang-en" id="build-date-en">${build.date.en}</span><span class="lang-ru" id="build-date-ru">${build.date.ru}</span></span>
              <span class="badge" id="build-final" hidden>${S.final}</span>
            </div>
            <a class="details-link" id="details-link" href="${image.path}">
              <span>${L('Screenshots, checksums and details', 'Скриншоты, хэши и описание')}</span> ${icon('d')}
            </a>
          </div>
          <div class="dl-actions">
            <a class="btn btn-primary btn-block" id="download-link" href="${image.url}">
              ${icon('download')} <span>${S.downloadIso} · <span class="lang-en" id="download-size-en">${formatSize(image.size, 'en')}</span><span class="lang-ru" id="download-size-ru">${formatSize(image.size, 'ru')}</span></span>
            </a>
            <div class="dl-alt">
              <a class="btn btn-secondary btn-sm" id="torrent-link" href="${image.url}.torrent">Torrent</a>
              <a class="btn btn-secondary btn-sm" id="magnet-link" href="${esc(image.magnet)}" ${countAttr(image.file, 'magnet')}>Magnet</a>
            </div>
            ${statsLine(image.file)}
            ${supportNudge}
          </div>
        </div>
      </section>

      ${tgCard('home')}

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
    description: {
      en: 'Windows 11 and Windows 10 IoT Enterprise LTSC builds by somov in English and Russian. Direct download, torrent and magnet.',
      ru: 'Сборки Windows 11 и Windows 10 IoT Enterprise LTSC от somov на русском и английском. Прямая загрузка, торрент и magnet.',
    },
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

function buildPage(build, preset) {
  const images = Object.fromEntries(LANGS.map(l => [l, imageFor(build, l)]));
  const other = l => (l === 'ru' ? 'en' : 'ru');
  const start = preset || PAGE_LANG;
  // One block per image language; CSS shows the one chosen in <html data-image>.
  const V = (fn, tag = 'div', cls = '') => LANGS.map(l => `<${tag} class="img-${l}${cls ? ' ' + cls : ''}">${fn(l)}</${tag}>`).join('');
  const switchLink = (l, content, cls = '') =>
    `<a${cls ? ` class="${cls}"` : ''} href="/windows-${build.id}-${l}" data-switch-image="${l}"${l === start ? ' aria-current="true"' : ''}>${content}</a>`;

  const sumsFor = l => [
    ['SHA-256', images[l].sums.sha256], ['SHA-1', images[l].sums.sha1], ['MD5', images[l].sums.md5],
  ].filter(([, value]) => value);
  const forImage = {
    en: L('For the English image', 'Для образа на английском'),
    ru: L('For the Russian image', 'Для образа на русском'),
  };
  const showFor = {
    en: L('show for the English image', 'показать для английского'),
    ru: L('show for the Russian image', 'показать для русского'),
  };

  const body = `<main class="page" id="content">
    <div class="container build">
      <div class="build-head">
        <a href="/" class="back">${icon('back')} ${S.home}</a>
        <h1 class="page-title">${esc(build.title)}</h1>
        <div class="meta">
          <span class="author">${L('Author:', 'Автор:')} <b>somov</b></span>
          <span aria-hidden="true">·</span>
          <span>${build.version}</span>
          <span aria-hidden="true">·</span>
          <span class="mono">${build.number}</span>
          <span aria-hidden="true">·</span>
          <span>${T(build.date)}</span>
          ${build.final ? `<span class="badge">${S.final}</span>` : ''}
        </div>
        ${shareRow()}
        <p class="lead">${T(build.lead)}</p>
      </div>

      <aside class="build-panel" ${attr('aria-label', 'Download', 'Скачать')}>
        <div class="panel">
          <div class="panel-title">${esc(build.title)}</div>
          <div class="panel-label">${L('Image language', 'Язык образа')}</div>
          <nav class="seg-links" ${attr('aria-label', 'Image language', 'Язык образа')}>
            ${LANGS.map(l => switchLink(l, imageLangName(l))).join('\n            ')}
          </nav>
          <dl class="panel-rows">
            <div><dt>${L('Size', 'Размер')}</dt><dd>${V(l => sizeL(images[l].size), 'span')}</dd></div>
            <div><dt>${L('Format', 'Формат')}</dt><dd>ISO · x64</dd></div>
          </dl>
          <div class="dl-actions">
            ${V(l => `
              <a class="btn btn-primary btn-block" href="${images[l].url}">${icon('download')} <span>${S.downloadIso}</span></a>
              <div class="dl-alt">
                <a class="btn btn-secondary btn-sm" href="${images[l].url}.torrent">Torrent</a>
                <a class="btn btn-secondary btn-sm" href="${esc(images[l].magnet)}" ${countAttr(images[l].file, 'magnet')}>Magnet</a>
              </div>
              ${statsLine(images[l].file)}`, 'div', 'dl-variant')}
            ${supportNudge}
          </div>
        </div>
        ${tgCard('build')}
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
          ${LANGS.map(l => `<div class="gallery img-${l}">
          ${gallery(build, l)}
          </div>`).join('\n          ')}
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
          ${V(l => `
          <p class="section-note">${forImage[l]} · ${switchLink(other(l), showFor[other(l)], 'link')}</p>
          <div class="sums">
            ${sumsFor(l).map(([label, value]) => `<div class="sum-row">
              <span class="sum-label">${label}</span>
              <span class="sum-val">${value}</span>
              <button type="button" class="icon-btn" data-copy="${value}" ${attr('aria-label', `Copy ${label}`, `Скопировать ${label}`)}>${icon('copy')}</button>
            </div>`).join('\n            ')}
          </div>
          <p class="sums-file">${esc(images[l].file)}</p>`)}
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
    ${LANGS.map(l => `<a class="btn btn-primary btn-block img-${l}" href="${images[l].url}">${icon('download')} <span>${S.downloadIso} · ${sizeL(images[l].size)}</span></a>`).join('\n    ')}
  </div>

  <dialog class="lightbox" id="lightbox" ${attr('aria-label', 'Screenshot', 'Скриншот')}>
    <img src="data:," alt="">
    <button type="button" class="lb-btn lb-close" ${attr('aria-label', 'Close', 'Закрыть')}>${icon('close')}</button>
    <button type="button" class="lb-btn lb-prev" ${attr('aria-label', 'Previous', 'Предыдущий')}>${icon('left')}</button>
    <button type="button" class="lb-btn lb-next" ${attr('aria-label', 'Next', 'Следующий')}>${icon('right')}</button>
    <div class="lb-count"></div>
  </dialog>`;

  const sizes = LANGS.map(l => formatSize(images[l].size, 'en')).join(' / ');
  write(`windows-${build.id}${preset ? '-' + preset : ''}.html`, shell({
    path: `/windows-${build.id}`,
    imageDefault: preset,
    title: {
      en: `${build.title} - Windows by somov`,
      ru: `${build.title} - Windows от somov`,
    },
    description: {
      en: `${build.title} ${build.version}, build ${build.number}. English and Russian images (${sizes}). Direct download, torrent, magnet and checksums.`,
      ru: `${build.title} ${build.version}, сборка ${build.number}. Образы на русском и английском (${LANGS.map(l => formatSize(images[l].size, 'ru')).join(' / ')}). Прямая загрузка, торрент, magnet и контрольные суммы.`,
    },
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
            ${item.sha256 ? `<button type="button" class="hash-copy" data-copy="${item.sha256}" ${attr('title', 'Copy SHA-256', 'Скопировать SHA-256')}>SHA-256 <code>${item.sha256.slice(0, 8)}…${item.sha256.slice(-8)}</code> ${icon('copy')}</button>` : ''}
            ${statsLine(item.file, 'download,torrent')}
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
      <p class="notice">
        ${L('This page is a download mirror. For questions and support, contact the author:', 'Страница работает как зеркало для скачивания. Вопросы и поддержка у автора:')}
        <a class="link" href="${ghost.youtube}" target="_blank" rel="noopener">YouTube</a> ·
        <a class="link" href="${ghost.website}" target="_blank" rel="noopener">${L('Website', 'Сайт')}</a>
      </p>
      <div class="section">
        ${ghost.groups.map(group => `<section class="group">
        <h2 class="group-title">${group.title}</h2>
        <div class="rows">
        ${group.items.map(row).join('\n        ')}
        </div>
        </section>`).join('\n        ')}
      </div>
    </div>
  </main>`;

  write('ghost-spectre.html', shell({
    path: '/ghost-spectre',
    title: { en: 'Ghost Spectre - Windows by somov', ru: 'Ghost Spectre - Windows от somov' },
    description: {
      en: 'Windows 10 and Windows 11 builds by Ghost Spectre: versions, dates and sizes. Direct download and torrent.',
      ru: 'Сборки Windows 10 и Windows 11 от Ghost Spectre: версии, даты и размеры. Прямая загрузка и торрент.',
    },
  }, 'ghost', body));
}

/* -- Settings ------------------------------------------------------------ */

const shareRow = () => `<div class="share">
          <div class="share-more">
            <button type="button" class="share-btn" data-share-toggle aria-haspopup="menu" aria-expanded="false">${icon('share')} ${L('Share', 'Поделиться')}</button>
            <div class="share-menu" role="menu" hidden>
              <button type="button" role="menuitem" data-share-copy>${icon('link')} ${L('Copy link', 'Скопировать ссылку')}</button>
              <button type="button" role="menuitem" data-share-native hidden>${icon('share')} ${L('Other apps…', 'Другие приложения…')}</button>
              <span class="share-sep" role="separator"></span>
              <a role="menuitem" href="#" target="_blank" rel="noopener" data-share-service="telegram">Telegram</a>
              <a role="menuitem" href="#" target="_blank" rel="noopener" data-share-service="whatsapp">WhatsApp</a>
              <a role="menuitem" href="#" target="_blank" rel="noopener" data-share-service="vk">${L('VK', 'ВКонтакте')}</a>
              <a role="menuitem" href="#" target="_blank" rel="noopener" data-share-service="x">X</a>
              <a role="menuitem" href="#" target="_blank" rel="noopener" data-share-service="facebook">Facebook</a>
              <a role="menuitem" href="#" target="_blank" rel="noopener" data-share-service="reddit">Reddit</a>
              <a role="menuitem" href="#" data-share-service="email">Email</a>
            </div>
          </div>
        </div>`;

const tgCard = placement => `<a class="tg-card" href="${TELEGRAM}" target="_blank" rel="noopener" data-tg-placement="${placement}">
          <span class="tg-icon">${icon('send')}</span>
          <span class="tg-text">
            <span class="tg-title">${L('Be the first to know about new builds', 'Узнавайте о новых сборках первыми')}</span>
            <span class="tg-sub">${L('Updates, tweaks and answers to questions on Telegram', 'Обновления, твики и ответы на вопросы — в Telegram')}</span>
          </span>
          <span class="tg-action" ${attr('aria-label', 'Subscribe', 'Подписаться')}>${icon('d')}</span>
        </a>
        <p class="stats-line tg-stats" data-tg-stats="${placement}" hidden></p>`;

/* -- Tweaks: shared pieces of the settings list and the tweak pages ------- */

const TWEAK_TAGS = {
  admin: L('Run as administrator', 'Нужны права администратора'),
  reboot: L('Restart required', 'Нужна перезагрузка'),
};

const fileTypeOf = file => decodeURIComponent(file).match(/\.[a-z0-9]+$/i)?.[0].toLowerCase() ?? '';

// Plain text of a bilingual value in one language (for <title> and descriptions).
const textIn = (value, lang) => (value && typeof value === 'object' ? value[lang] : value);

// A link may exist in one language only, or point to a different URL per language.
// Owner-only counter line of a tweak: file downloads (counted by the server), copies and link clicks (reported by the site).
const tweakStats = item => {
  const files = [item.file, ...(item.downloads ?? []).map(d => d.file)].filter(Boolean).map(f => decodeURIComponent(f));
  const kinds = [files.length && 'download', item.commands && 'copy', item.links?.length && 'link'].filter(Boolean);
  return kinds.length ? `<p class="stats-line tweak-stats" data-tweak-stats="${item.id}" data-files="${esc(files.join('|'))}" data-kinds="${kinds.join(',')}" hidden></p>` : '';
};
const tweakCount = (id, kind) => `data-count-tweak="${id}" data-count-kind="${kind}"`;

const tweakLinkHtml = (link, id) => {
  const labelFor = lang => (typeof link.label === 'object' ? link.label[lang] : link.label);
  const urlFor = lang => (typeof link.url === 'object' ? link.url[lang] : link.url);
  if (labelFor('en') && labelFor('ru') && urlFor('en') === urlFor('ru')) {
    return `<a class="link" href="${esc(urlFor('en'))}" target="_blank" rel="noopener" ${tweakCount(id, 'link')}>${T(link.label)}</a>`;
  }
  return LANGS.filter(labelFor).map(lang =>
    `<a class="link lang-${lang}" href="${esc(urlFor(lang))}" target="_blank" rel="noopener" ${tweakCount(id, 'link')}>${esc(labelFor(lang))}</a>`).join('');
};

const tweakCommands = item => (item.commands ? `<div class="commands">${item.commands.map(c => `<div>
              <div class="command-label">${T(c.label)}</div>
              <div class="command"><code>${esc(c.code)}</code><button type="button" class="icon-btn" data-copy="${esc(c.code)}" ${tweakCount(item.id, 'copy')} ${attr('aria-label', 'Copy command', 'Скопировать команду')}>${icon('copy')}</button></div>
            </div>`).join('')}</div>` : '');
const tweakDownloads = item => (item.downloads ? `<div class="chip-links">${item.downloads.map(d => `<a class="btn btn-secondary btn-sm" href="${CDN}${d.file}">${icon('download')} ${esc(d.label)}</a>`).join('')}</div>` : '');
const tweakKeys = item => (item.keys ? `<dl class="keys">${item.keys.map(k => `<div><dt>${T(k.combo)}</dt><dd>${T(k.desc)}</dd></div>`).join('')}</dl>` : '');
const tweakTags = item => (item.tags?.length ? `<div class="item-tags">${item.tags.map(tag => `<span class="badge">${TWEAK_TAGS[tag]}</span>`).join('')}</div>` : '');

// General "how to apply" steps by file type; only facts that hold for any file of that type.
function applySteps(item) {
  const type = fileTypeOf(item.file);
  const admin = item.tags?.includes('admin');
  const reboot = item.tags?.includes('reboot');
  const download = L('Download the file.', 'Скачайте файл.');
  let steps;
  if (type === '.reg') {
    steps = [download, L('Double-click it to run.', 'Запустите его двойным щелчком.'), L('Confirm adding the data to the registry.', 'Подтвердите добавление данных в реестр.')];
  } else if (type === '.bat' || type === '.cmd') {
    steps = [download, admin
      ? L('Right-click it and choose “Run as administrator”.', 'Нажмите на него правой кнопкой и выберите «Запуск от имени администратора».')
      : L('Run it with a double-click.', 'Запустите его двойным щелчком.')];
  } else if (type === '.zip' || type === '.rar') {
    steps = [L('Download the archive.', 'Скачайте архив.'), L('Unpack it to any folder.', 'Распакуйте его в любую папку.'), L('Run the program or script from that folder.', 'Запустите программу или скрипт из этой папки.')];
  } else {
    steps = [download, L('Run it and follow the instructions on the screen.', 'Запустите его и следуйте инструкциям на экране.')];
  }
  if (reboot) steps.push(L('Restart your computer.', 'Перезагрузите компьютер.'));
  return steps;
}

function settingsPage() {
  const TAGS = TWEAK_TAGS;
  const fileType = fileTypeOf;
  const linkHtml = tweakLinkHtml;

  // Both languages are searchable, whichever one is on screen.
  const plain = value => (value && typeof value === 'object' ? Object.values(value) : [value]);

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
            <h3 class="item-title"><a href="/tweaks/${item.id}">${T(item.title)}</a></h3>
            ${item.desc ? `<p class="item-desc">${T(item.desc)}</p>` : ''}
            ${item.tags?.length ? `<div class="item-tags">${item.tags.map(tag => `<span class="badge">${TAGS[tag]}</span>`).join('')}</div>` : ''}
            ${item.links?.length ? `<div class="item-links">${item.links.map(l => linkHtml(l, item.id)).join('')}</div>` : ''}
            ${item.commands ? `<div class="commands">${item.commands.map(c => `<div>
              <div class="command-label">${T(c.label)}</div>
              <div class="command"><code>${esc(c.code)}</code><button type="button" class="icon-btn" data-copy="${esc(c.code)}" ${tweakCount(item.id, 'copy')} ${attr('aria-label', 'Copy command', 'Скопировать команду')}>${icon('copy')}</button></div>
            </div>`).join('')}</div>` : ''}
            ${item.downloads ? `<div class="chip-links">${item.downloads.map(d => `<a class="btn btn-secondary btn-sm" href="${CDN}${d.file}">${icon('download')} ${esc(d.label)}</a>`).join('')}</div>` : ''}
            ${item.keys ? `<dl class="keys">${item.keys.map(k => `<div><dt>${T(k.combo)}</dt><dd>${T(k.desc)}</dd></div>`).join('')}</dl>` : ''}
            ${tweakStats(item)}
          </div>
          ${hasAction ? `<div class="item-action">
            <span class="file-type">${fileType(item.file)}</span>
            <a class="btn btn-secondary btn-sm" href="${CDN}${item.file}">${icon('download')} <span>${S.download}</span></a>
          </div>` : ''}
        </article>`;
  };

  // The first section of the page, from _src/data/featured.json ("show": false hides it).
  // It works like a category: its own chip, search and filter. "file" is a file name on dl3 or a full https:// address.
  const featuredHtml = () => {
    if (!featured.show) return '';
    const f = featured;
    const fileUrl = f.file && (/^https?:\/\//.test(f.file) ? f.file : CDN + f.file);
    const fileName = f.file && decodeURIComponent(f.file.split('/').pop());
    const searchText = [...plain(f.heading), ...plain(f.title), ...plain(f.desc), ...plain(f.link?.label), fileName]
      .filter(Boolean).join(' ').toLowerCase();
    // Owner-only line, like the tweaks: downloads of a file on dl3 and clicks on the link
    const statsFile = f.file && !/^https?:\/\//.test(f.file) ? fileName : '';
    const kinds = [statsFile && 'download', f.link?.url && 'link'].filter(Boolean);
    const featuredStats = kinds.length
      ? `<p class="stats-line tweak-stats" data-tweak-stats="featured" data-files="${esc(statsFile)}" data-kinds="${kinds.join(',')}" hidden></p>`
      : '';
    return `<section class="section group" data-group="featured">
        <h2 class="group-title">${T(f.heading)}</h2>
        <div class="rows">
        <article class="item" id="featured" data-category="featured" data-search="${esc(searchText)}">
          <div${fileUrl ? '' : ' class="item-full"'}>
            <h3 class="item-title">${T(f.title)}</h3>
            ${f.desc ? `<p class="item-desc">${T(f.desc)}</p>` : ''}
            ${f.link?.url ? `<div class="item-links">${tweakLinkHtml(f.link, 'featured')}</div>` : ''}
            ${featuredStats}
          </div>
          ${fileUrl ? `<div class="item-action">
            <span class="file-type">${fileTypeOf(fileName)}</span>
            <a class="btn btn-secondary btn-sm" href="${esc(fileUrl)}">${icon('download')} <span>${S.download}</span></a>
          </div>` : ''}
        </article>
        </div>
      </section>`;
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
          ${featured.show ? `<button type="button" class="chip" data-category="featured" aria-pressed="false">${T(featured.heading)}</button>` : ''}
          ${settings.categories.map(c => `<button type="button" class="chip" data-category="${c.id}" aria-pressed="false">${T(c.title)}</button>`).join('\n          ')}
        </div>
      </div>

      <p class="result-count" id="result-count" role="status"></p>
      <details class="owner-stats" id="owner-stats" hidden>
        <summary>${L('Popularity (visible only to you)', 'Популярность (видно только вам)')}</summary>
        <ol></ol>
      </details>
      <p class="empty" id="empty" hidden>${L('Nothing found. Try another word or category.', 'Ничего не найдено. Попробуйте другое слово или категорию.')}</p>

      ${featuredHtml()}

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
    description: {
      en: 'Windows tweaks, drivers, PowerShell commands and useful tools, with search and categories.',
      ru: 'Твики Windows, драйверы, команды PowerShell и полезные утилиты, с поиском и категориями.',
    },
  }, 'settings', body));
}

/* -- Tweak pages ------------------------------------------------------------ */

function tweakPage(item) {
  const category = settings.categories.find(c => c.id === item.category);
  const related = settings.items.filter(i => i.category === item.category && i !== item).slice(0, 6);
  const titleIn = lang => textIn(item.title, lang);
  const descIn = lang => textIn(item.desc, lang)
    || [titleIn(lang), ...(item.commands ?? []).map(c => textIn(c.label, lang))].join('. ');

  const action = item.file ? `<section class="tweak-card">
          <div class="tweak-download">
            <a class="btn btn-primary" href="${CDN}${item.file}">${icon('download')} <span>${S.download}</span></a>
            <span class="file-type">${fileTypeOf(item.file)}</span>
          </div>
          <h2>${L('How to apply', 'Как применить')}</h2>
          <ol class="steps">
            ${applySteps(item).map(step => `<li><span>${step}</span></li>`).join('\n            ')}
          </ol>
        </section>` : '';
  const extras = [tweakCommands(item), tweakDownloads(item), tweakKeys(item)].filter(Boolean).join('');

  const body = `<main class="page" id="content">
    <div class="container container-narrow">
      <a href="/settings-for-windows" class="back">${icon('back')} ${L('Settings for Windows', 'Настройки для Windows')}</a>
      <p class="tweak-category">${T(category.title)}</p>
      <h1 class="page-title">${T(item.title)}</h1>
      ${shareRow()}
      ${item.desc ? `<p class="lead">${T(item.desc)}</p>` : ''}
      ${tweakTags(item)}
      ${item.links?.length ? `<div class="item-links">${item.links.map(l => tweakLinkHtml(l, item.id)).join('')}</div>` : ''}
      ${tweakStats(item)}
      ${action}
      ${extras ? `<section class="tweak-card">${extras}</section>` : ''}
      ${related.length ? `<section class="section">
        <h2>${L('More in this category', 'Ещё в этой категории')}</h2>
        <div class="rows">
          ${related.map(r => `<a class="related" href="/tweaks/${r.id}"><span>${T(r.title)}</span>${icon('d')}</a>`).join('\n          ')}
        </div>
      </section>` : ''}
    </div>
  </main>`;

  write(`tweaks/${item.id}.html`, shell({
    path: `/tweaks/${item.id}`,
    title: {
      en: `${titleIn('en')} - Windows tweaks by somov`,
      ru: `${titleIn('ru')} - настройки Windows от somov`,
    },
    description: { en: descIn('en'), ru: descIn('ru') },
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

/* -- Support ------------------------------------------------------------- */

// One card for all coins: pick a coin from a list, then a network if the coin has several.
function cryptoCard(copyRow) {
  const first = CRYPTO[0];
  const variants = CRYPTO.flatMap(coin => coin.networks.map(net => ({ coin, net, key: coin.networks.length > 1 ? `${coin.id}-${net.id}` : coin.id })));
  const isDefault = v => v.coin === first && v.net === first.networks[0];
  const chevron = `<svg class="select-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
  return `<article class="support-card crypto" id="crypto" data-crypto>
          <h2>${L('Crypto', 'Криптовалюта')}</h2>
          <div class="crypto-fields">
            <div class="select-field">
              <label class="select-label" for="crypto-coin">${L('Coin', 'Монета')}</label>
              <span class="select-wrap">
                <select id="crypto-coin" data-coin-select>
                  ${CRYPTO.map(coin => `<option value="${coin.id}" data-name="${coin.name}" data-sub="${coin.title}">${coin.name} · ${coin.title}</option>`).join('')}
                </select>
                ${chevron}
              </span>
            </div>
            ${CRYPTO.filter(coin => coin.networks.length > 1).map(coin => `<div class="select-field" data-networks-for="${coin.id}"${coin === first ? '' : ' hidden'}>
              <label class="select-label" for="crypto-network-${coin.id}">${L('Network', 'Сеть')}</label>
              <span class="select-wrap">
                <select id="crypto-network-${coin.id}" data-network-select>
                  ${coin.networks.map(net => {
                    const name = net.network.replace(/\s*\(.*\)$/, '');
                    const sub = net.label && net.label !== name ? net.label : '';
                    return `<option value="${net.id}" data-name="${name}" data-sub="${sub}">${net.network}</option>`;
                  }).join('')}
                </select>
                ${chevron}
              </span>
            </div>`).join('\n            ')}
          </div>
          ${variants.map(v => `<div class="crypto-variant" data-variant="${v.key}"${isDefault(v) ? '' : ' hidden'}>
            <a class="qr-wrap" href="/images/qr-${v.net.qr}.png" download="somov-${v.key}-qr.png" ${attr('title', 'Save QR code', 'Сохранить QR-код')}>
              <img class="qr" src="/images/qr-${v.net.qr}.svg" width="160" height="160" ${attr('alt', `QR code of the ${v.coin.name} address`, `QR-код адреса ${v.coin.name}`)} loading="lazy">
              <span class="qr-save" aria-hidden="true">${icon('download')}</span>
            </a>
            <div class="crypto-info">
              <p class="crypto-warning">${L(`Send only <b>${v.coin.name}</b> on the <b>${v.net.network}</b> network. A transfer on another network may be lost.`, `Отправляйте только <b>${v.coin.name}</b> в сети <b>${v.net.network}</b>. Перевод в другой сети может потеряться.`)}</p>
              ${copyRow(v.net.address, v.coin.name)}
            </div>
          </div>`).join('\n          ')}
          <noscript>
            <ul class="crypto-list">
              ${variants.map(v => `<li><b>${v.coin.name} · ${v.net.network}</b><br><code>${v.net.address}</code></li>`).join('')}
            </ul>
          </noscript>
        </article>`;
}

function supportPage() {
  const copyRow = (value, label) => `<div class="address">
            <code>${esc(value)}</code>
            <button type="button" class="icon-btn" data-copy="${esc(value)}" ${attr('aria-label', `Copy ${label} address`, `Скопировать адрес ${label}`)}>${icon('copy')}</button>
          </div>`;

  const cards = [
    DONATE.patreon && `<article class="support-card support-card-main">
          <h2>Patreon</h2>
          <p>${L('Any bank card, one-time or monthly.', 'Любая банковская карта, разово или ежемесячно.')}</p>
          <a class="btn btn-primary" href="${esc(DONATE.patreon)}" target="_blank" rel="noopener">${L('Support on Patreon', 'Поддержать на Patreon')}</a>
        </article>`,
    DONATE.tribute && `<article class="support-card support-card-tribute" id="tribute">
          <h2>${L('Bank card', 'Банковская карта')}</h2>
          <p>${L('Cards from any country, through Tribute.', 'Карты любых стран, через Tribute.')}</p>
          <a class="btn btn-secondary" href="${esc(DONATE.tribute)}" target="_blank" rel="noopener">${L('Support by card', 'Поддержать картой')}</a>
        </article>`,
    cryptoCard(copyRow),
    `<article class="support-card support-card-yoomoney" id="yoomoney">
          <h2>${L('YooMoney', 'ЮMoney')}</h2>
          <p>${L('Russian bank cards and YooMoney wallet.', 'Российские карты и кошелёк ЮMoney.')}</p>
          <a class="btn btn-secondary" href="${esc(DONATE.yoomoney)}" target="_blank" rel="noopener">${L('Open YooMoney', 'Перейти в ЮMoney')}</a>
        </article>`,
  ].filter(Boolean);

  const body = `<main class="page" id="content">
    <div class="container container-narrow">
      <a href="/" class="back">${icon('back')} ${S.home}</a>
      <h1 class="page-title">${L('Support the project', 'Поддержать проект')}</h1>
      <p class="page-sub">${L('All builds and tools on somov.org are free. If they saved you time, you can support the project: it helps pay for the servers and keep the builds up to date. Thank you!', 'Все сборки и утилиты на somov.org бесплатные. Если они сэкономили вам время, можно поддержать проект: это помогает оплачивать серверы и обновлять сборки. Спасибо!')}</p>
      <div class="support-grid">
        ${cards.join('\n        ')}
      </div>
    </div>
  </main>`;

  write('support.html', shell({
    path: '/support',
    title: { en: 'Support the project - Windows by somov', ru: 'Поддержать проект - Windows от somov' },
    description: {
      en: 'Ways to support Windows by somov: bank card, crypto (USDT, USDC, BTC, ETH, LTC, DOGE) and YooMoney.',
      ru: 'Как поддержать Windows by somov: банковская карта, криптовалюта (USDT, USDC, BTC, ETH, LTC, DOGE) и ЮMoney.',
    },
  }, '', body));
}

/* -- Robots and sitemap -------------------------------------------------- */

// Every page of the site, without the /ru prefix and the -en / -ru build variants
const sitePaths = () => ['/', '/ghost-spectre', '/settings-for-windows', '/support',
  ...builds.map(b => `/windows-${b.id}`),
  ...settings.items.map(i => `/tweaks/${i.id}`)];

// What the counter on dl3 accepts: it downloads this file from somov.org and ignores anything else,
// so nobody can fill the stats with made-up pages or tweaks.
function counterKeys() {
  writeFileSync(join(ROOT, 'counter-keys.json'), JSON.stringify({
    pages: sitePaths(),
    tweaks: [...settings.items.map(i => i.id), ...(featured.show ? ['featured'] : [])],
    places: ['header', 'footer', 'home', 'build'], // data-tg-placement of the Telegram links
  }, null, 2) + '\n');
}

function sitemap() {
  const paths = sitePaths();
  const alternates = path => LANGS.map(l => `    <xhtml:link rel="alternate" hreflang="${l}" href="${SITE}${langPath(l, path)}"/>`).join('\n');
  write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${paths.flatMap(path => LANGS.map(lang => `  <url>
    <loc>${SITE}${langPath(lang, path)}</loc>
${alternates(path)}
  </url>`)).join('\n')}
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

for (const lang of LANGS) {
  PAGE_LANG = lang;
  homePage();
  ghostPage();
  settingsPage();
  for (const item of settings.items) tweakPage(item);
  supportPage();
  for (const build of builds) {
    buildPage(build, null);
    for (const imageLang of LANGS) buildPage(build, imageLang);
  }
}
PAGE_LANG = 'en';
notFoundPage();
sitemap();
counterKeys();
console.log('Site built.');
