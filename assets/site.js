(function () {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const root = document.documentElement;

  const STRINGS = {
    en: { copied: 'Copied', copyFailed: 'Could not copy', found: 'Found', clicks: 'Downloads', download: 'Download', linkCopied: 'Link copied', copies: 'Copies', linkClicks: 'Link clicks', tgClicks: 'Telegram clicks', fromHere: 'from here', views: 'Page views', today: 'today', week: '7 days', month: '30 days', total: 'all time', onlyYou: 'visible only to you' },
    ru: { copied: 'Скопировано', copyFailed: 'Не удалось скопировать', found: 'Найдено', clicks: 'Скачиваний', download: 'Скачать', linkCopied: 'Ссылка скопирована', copies: 'Копирований', linkClicks: 'Переходов', tgClicks: 'Переходов в Telegram', fromHere: 'отсюда', views: 'Просмотры страницы', today: 'сегодня', week: 'неделя', month: 'месяц', total: 'всего', onlyYou: 'видно только вам' },
  };
  const currentLang = () => (root.lang === 'ru' ? 'ru' : 'en');
  const t = key => STRINGS[currentLang()][key];

  /* Language: both languages are in the page, the class on <html> picks one */
  function applyLang(lang) {
    root.lang = lang;
    root.classList.toggle('lang-ru-active', lang === 'ru');
    root.classList.toggle('lang-en-active', lang !== 'ru');
    const title = lang === 'ru' ? root.dataset.titleRu : root.dataset.titleEn;
    if (title) document.title = title;
    $$('[data-i18n]').forEach(element => {
      Object.entries(JSON.parse(element.dataset.i18n)).forEach(([name, values]) => {
        element.setAttribute(name, values[lang]);
      });
    });
    $$('[data-set-lang]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.setLang === lang));
    });
  }

  const languageListeners = [];
  $$('[data-set-lang]').forEach(button => {
    button.addEventListener('click', () => {
      const lang = button.dataset.setLang;
      try { localStorage.setItem('siteLanguage', lang); } catch (e) {}
      applyLang(lang);
      languageListeners.forEach(listener => listener(lang));
    });
  });
  applyLang(currentLang());

  /* Toast and copy to clipboard */
  const toast = $('#toast');
  let toastTimer;
  function showToast(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 1800);
  }

  function legacyCopy(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    if (!copied) throw new Error('copy failed');
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
    }
    return new Promise(resolve => resolve(legacyCopy(text)));
  }

  $$('[data-copy]').forEach(button => {
    let timer;
    button.addEventListener('click', () => {
      copyText(button.dataset.copy).then(() => {
        button.classList.add('is-copied');
        showToast(t('copied'));
        clearTimeout(timer);
        timer = setTimeout(() => button.classList.remove('is-copied'), 1800);
      }).catch(() => showToast(t('copyFailed')));
    });
  });

  /* Download counter: report clicks; the server returns the counts only to the owner's IP */
  const COUNTER = 'https://dl3.somov.org/api';

  function reportClick(event) {
    const link = event.target.closest && event.target.closest('[data-count-file], [data-count-tweak]');
    if (!link) return;
    const target = link.dataset.countTweak ? 'tweak=' + link.dataset.countTweak : 'file=' + encodeURIComponent(link.dataset.countFile);
    const url = COUNTER + '/count?' + target + '&kind=' + link.dataset.countKind;
    if (!(navigator.sendBeacon && navigator.sendBeacon(url))) {
      fetch(url, { method: 'POST', mode: 'no-cors', keepalive: true }).catch(() => {});
    }
  }
  document.addEventListener('click', reportClick);
  document.addEventListener('auxclick', event => {
    if (event.button === 1) reportClick(event);
  });

  let statsCounts = null;
  function renderStats() {
    if (!statsCounts) return;
    $$('[data-stats-file]').forEach(line => {
      const counts = statsCounts[line.dataset.statsFile] || {};
      const parts = line.dataset.statsKinds.split(',').map(kind => ({
        label: kind === 'download' ? t('download') : kind === 'torrent' ? 'Torrent' : 'Magnet',
        value: counts[kind] || 0,
      }));
      const total = parts.reduce((sum, part) => sum + part.value, 0);
      line.textContent = t('clicks') + ': ' + total + ' (' + parts.map(part => part.label + ' ' + part.value).join(' · ') + ')';
      line.hidden = false;
    });

    // Tweaks: downloads of their files (the server counts them under the tweak, whatever the file version),
    // copied commands and opened links
    const tweakNumbers = line => {
      const own = statsCounts['tweak:' + line.dataset.tweakStats] || {};
      return {
        download: own.download || 0,
        copy: own.copy || 0,
        link: own.link || 0,
      };
    };
    const tweakText = (line, numbers) => line.dataset.kinds.split(',')
      .map(kind => t(kind === 'download' ? 'clicks' : kind === 'copy' ? 'copies' : 'linkClicks') + ': ' + numbers[kind]).join(' · ');
    $$('[data-tweak-stats]').forEach(line => {
      line.textContent = tweakText(line, tweakNumbers(line));
      line.hidden = false;
    });

    // Telegram cards: clicks on any channel link on the site, and on this card's place
    $$('[data-tg-stats]').forEach(line => {
      const here = (statsCounts['tg:' + line.dataset.tgStats] || {}).click || 0;
      line.textContent = t('tgClicks') + ': ' + ((statsCounts.tg || {}).click || 0) + ' · ' + t('fromHere') + ' ' + here;
      line.hidden = false;
    });

    // Settings page: every tweak ranked by its total, for the owner only
    const ranking = $('#owner-stats');
    if (ranking) {
      const rows = $$('.item [data-tweak-stats]').map(line => {
        const numbers = tweakNumbers(line);
        const item = line.closest('.item');
        const link = $('.item-title a', item);
        // Tweaks link to their own page; the featured item at the top has none, so it links to itself
        const href = link ? link.getAttribute('href') : '#' + item.id;
        // Not innerText: for an item hidden by the search it returns both languages at once
        const titleEl = $('.item-title', item);
        const title = ($('.lang-' + currentLang(), titleEl) || titleEl).textContent.trim();
        return { numbers, line, total: numbers.download + numbers.copy + numbers.link, title, href };
      }).sort((a, b) => b.total - a.total);
      $('ol', ranking).replaceChildren(...rows.map(row => {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = row.href;
        a.textContent = row.title;
        const value = document.createElement('span');
        value.textContent = row.total;
        value.title = tweakText(row.line, row.numbers);
        li.append(a, value);
        return li;
      }));
      ranking.hidden = false;
    }
  }
  if ($('[data-stats-file], [data-tweak-stats], [data-tg-stats]')) {
    languageListeners.push(renderStats);
    // The page asks the counter once, in <head>; see `analytics` in _src/build.mjs.
    (window.siteOwner || fetch(COUNTER + '/stats').then(response => response.json()))
      .then(data => {
        if (data.owner) {
          statsCounts = data.counts;
          renderStats();
        }
      })
      .catch(() => {});
  }

  /* Page views: one per IP per page per day, counted on the server (the owner is not counted).
     /ru copies and the -en / -ru build URLs count as the same page. The owner sees the numbers under the header. */
  if (!$('.not-found')) {
    const pagePath = (location.pathname.toLowerCase()
      .replace(/\.html$/, '').replace(/\/index$/, '/').replace(/^\/ru(?=\/|$)/, '')
      .replace(/^(\/windows-1[01])-(en|ru)$/, '$1').replace(/(.)\/+$/, '$1')) || '/';
    if (/^\/[a-z0-9/-]{0,100}$/.test(pagePath)) {
      const url = COUNTER + '/count?page=' + encodeURIComponent(pagePath) + '&kind=view';
      if (!(navigator.sendBeacon && navigator.sendBeacon(url))) {
        fetch(url, { method: 'POST', mode: 'no-cors', keepalive: true }).catch(() => {});
      }
      (window.siteOwner || fetch(COUNTER + '/stats').then(response => response.json()))
        .then(data => {
          const topbar = $('.topbar');
          if (!data.owner || !topbar) return;
          const views = data.counts['page:' + pagePath] || {};
          const bar = document.createElement('div');
          bar.className = 'page-views';
          bar.innerHTML = '<div class="container"></div>';
          const render = () => {
            bar.firstChild.textContent = t('views') + ': ' + ['today', 'week', 'month']
              .map(key => t(key) + ' ' + (views[key] || 0)).join(' · ') + ' · ' + t('total') + ' ' + (views.view || 0)
              + ' (' + t('onlyYou') + ')';
          };
          render();
          languageListeners.push(render);
          topbar.after(bar);
        })
        .catch(() => {});
    }
  }

  /* Home: build picker */
  const buildsData = $('#builds-data');
  if (buildsData) {
    const builds = JSON.parse(buildsData.textContent);
    const osInputs = $$('input[name="os"]');
    const langInputs = $$('input[name="image-lang"]');
    const selected = inputs => inputs.find(input => input.checked).value;
    const selectImageLang = lang => {
      langInputs.find(input => input.value === lang).checked = true;
    };

    function render() {
      const os = selected(osInputs);
      const imageLang = selected(langInputs);
      const build = builds[os];
      const image = build.images[imageLang];
      $('#build-title').textContent = build.title;
      $('#build-version').textContent = build.version;
      $('#build-number').textContent = build.number;
      $('#build-date-en').textContent = build.date.en;
      $('#build-date-ru').textContent = build.date.ru;
      $('#build-final').hidden = !build.final;
      $('#details-link').href = image.details;
      $('#build-title').href = image.details; // the title leads to the build page too
      $('#download-link').href = image.url;
      $('#download-size-en').textContent = image.size.en;
      $('#download-size-ru').textContent = image.size.ru;
      $('#torrent-link').href = image.url + '.torrent';
      $('#magnet-link').href = image.magnet;
      $('#magnet-link').dataset.countFile = image.file;
      $('.composer [data-stats-file]').dataset.statsFile = image.file;
      renderStats();
    }

    // The image language follows the site language.
    selectImageLang(currentLang());
    render();
    osInputs.concat(langInputs).forEach(input => input.addEventListener('change', render));
    languageListeners.push(lang => {
      selectImageLang(lang);
      render();
    });
  }

  /* Dropdown in the site style on top of a native <select>. The <select> keeps the value,
     so the page works without scripts; the list supports mouse, touch and keyboard. */
  let dropdownId = 0;
  function enhanceSelect(select) {
    const wrap = select.closest('.select-wrap');
    const label = $('.select-label', select.closest('.select-field'));
    if (label) label.removeAttribute('for'); // the native <select> is hidden now
    const id = 'dd' + (++dropdownId);
    const check = '<svg class="dd-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>';
    const content = option => {
      const name = document.createElement('span');
      name.className = 'dd-name';
      name.textContent = option.dataset.name || option.text;
      const sub = document.createElement('span');
      sub.className = 'dd-sub';
      sub.textContent = option.dataset.sub || '';
      return [name, sub];
    };

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dd-button';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    if (label) {
      label.id = id + '-label';
      button.setAttribute('aria-labelledby', id + '-label ' + id + '-value');
    }

    const list = document.createElement('ul');
    list.className = 'dd-list';
    list.setAttribute('role', 'listbox');
    list.tabIndex = -1;
    list.hidden = true;
    if (label) list.setAttribute('aria-labelledby', id + '-label');

    const items = Array.from(select.options).map((option, index) => {
      const item = document.createElement('li');
      item.id = id + '-' + index;
      item.setAttribute('role', 'option');
      item.dataset.value = option.value;
      item.append(...content(option));
      item.insertAdjacentHTML('beforeend', check);
      item.addEventListener('click', () => choose(index));
      item.addEventListener('mousemove', () => highlight(index));
      list.append(item);
      return item;
    });

    let active = select.selectedIndex;
    function paint() {
      const value = document.createElement('span');
      value.id = id + '-value';
      value.style.display = 'contents';
      value.append(...content(select.options[select.selectedIndex]));
      button.replaceChildren(value);
      items.forEach((item, i) => item.setAttribute('aria-selected', String(i === select.selectedIndex)));
    }
    function highlight(index) {
      active = (index + items.length) % items.length;
      items.forEach((item, i) => item.classList.toggle('is-active', i === active));
      list.setAttribute('aria-activedescendant', items[active].id);
      items[active].scrollIntoView({ block: 'nearest' });
    }
    function open() {
      list.hidden = false;
      wrap.classList.add('is-open');
      button.setAttribute('aria-expanded', 'true');
      highlight(select.selectedIndex);
      list.focus();
    }
    function close(returnFocus) {
      if (list.hidden) return;
      list.hidden = true;
      wrap.classList.remove('is-open');
      button.setAttribute('aria-expanded', 'false');
      if (returnFocus) button.focus();
    }
    function choose(index) {
      if (index !== select.selectedIndex) {
        select.selectedIndex = index;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      paint();
      close(true);
    }

    button.addEventListener('click', () => (list.hidden ? open() : close(false)));
    button.addEventListener('keydown', event => {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault();
        open();
      }
    });
    list.addEventListener('keydown', event => {
      const keys = {
        ArrowDown: () => highlight(active + 1),
        ArrowUp: () => highlight(active - 1),
        Home: () => highlight(0),
        End: () => highlight(items.length - 1),
        Enter: () => choose(active),
        ' ': () => choose(active),
        Escape: () => close(true),
      };
      if (keys[event.key]) {
        event.preventDefault();
        keys[event.key]();
      } else if (event.key === 'Tab') {
        close(false);
      }
    });
    document.addEventListener('click', event => {
      if (!wrap.contains(event.target)) close(false);
    });
    select.addEventListener('change', paint);

    wrap.prepend(button);
    wrap.append(list);
    wrap.classList.add('is-enhanced');
    paint();
  }

  /* Telegram links: report clicks to Analytics and to the counter with the place they came from */
  const reportTelegram = (link, event) => {
    if (event.type === 'auxclick' && event.button !== 1) return;
    if (typeof window.gtag === 'function') {
      window.gtag('event', 'telegram_click', { placement: link.dataset.tgPlacement, transport_type: 'beacon' });
    }
    const url = COUNTER + '/count?tg=' + link.dataset.tgPlacement + '&kind=click';
    if (!(navigator.sendBeacon && navigator.sendBeacon(url))) {
      fetch(url, { method: 'POST', mode: 'no-cors', keepalive: true }).catch(() => {});
    }
  };
  $$('[data-tg-placement]').forEach(link => {
    link.addEventListener('click', event => reportTelegram(link, event));
    link.addEventListener('auxclick', event => reportTelegram(link, event));
  });

  /* Support page: tapping a QR code downloads it; a download icon confirms it for a moment */
  $$('.qr-wrap').forEach(link => {
    let timer;
    link.addEventListener('click', () => {
      link.classList.add('is-saved');
      clearTimeout(timer);
      timer = setTimeout(() => link.classList.remove('is-saved'), 2000);
    });
  });

  /* Support page: pick a coin, then a network when the coin has several */
  const cryptoCard = $('[data-crypto]');
  if (cryptoCard) {
    const coinSelect = $('[data-coin-select]', cryptoCard);
    function renderCrypto() {
      const coin = coinSelect.value;
      let key = coin;
      $$('[data-networks-for]', cryptoCard).forEach(field => {
        field.hidden = field.dataset.networksFor !== coin;
        if (!field.hidden) key = coin + '-' + $('select', field).value;
      });
      $$('[data-variant]', cryptoCard).forEach(v => { v.hidden = v.dataset.variant !== key; });
    }
    $$('select', cryptoCard).forEach(select => {
      select.addEventListener('change', renderCrypto);
      enhanceSelect(select);
    });
    renderCrypto();
  }

  /* Build page: share the page as it is open now, including the image language in the URL */
  const shareUrl = () => location.origin + location.pathname;
  const shareLinks = {
    telegram: (url, title) => 'https://t.me/share/url?url=' + encodeURIComponent(url) + '&text=' + encodeURIComponent(title),
    whatsapp: (url, title) => 'https://wa.me/?text=' + encodeURIComponent(title + ' ' + url),
    vk: (url, title) => 'https://vk.com/share.php?url=' + encodeURIComponent(url) + '&title=' + encodeURIComponent(title),
    x: (url, title) => 'https://x.com/intent/post?url=' + encodeURIComponent(url) + '&text=' + encodeURIComponent(title),
    facebook: url => 'https://www.facebook.com/sharer/sharer.php?u=' + encodeURIComponent(url),
    reddit: (url, title) => 'https://www.reddit.com/submit?url=' + encodeURIComponent(url) + '&title=' + encodeURIComponent(title),
    email: (url, title) => 'mailto:?subject=' + encodeURIComponent(title) + '&body=' + encodeURIComponent(url),
  };
  $$('.share-more').forEach(box => {
    const toggle = $('[data-share-toggle]', box);
    const menu = $('.share-menu', box);
    const native = $('[data-share-native]', box);
    if (navigator.share) native.hidden = false;
    const items = () => $$('[role="menuitem"]', menu).filter(item => !item.hidden);
    function open() {
      const url = shareUrl();
      $$('[data-share-service]', menu).forEach(link => { link.href = shareLinks[link.dataset.shareService](url, document.title); });
      menu.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      items()[0].focus();
    }
    function close(returnFocus) {
      if (menu.hidden) return;
      menu.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      if (returnFocus) toggle.focus();
    }
    toggle.addEventListener('click', () => (menu.hidden ? open() : close(false)));
    menu.addEventListener('keydown', event => {
      const list = items();
      const index = list.indexOf(document.activeElement);
      if (event.key === 'Escape') { event.preventDefault(); close(true); }
      if (event.key === 'ArrowDown') { event.preventDefault(); list[(index + 1) % list.length].focus(); }
      if (event.key === 'ArrowUp') { event.preventDefault(); list[(index - 1 + list.length) % list.length].focus(); }
      if (event.key === 'Tab') close(false);
    });
    menu.addEventListener('click', event => {
      const item = event.target.closest('[role="menuitem"]');
      if (!item) return;
      if (item.matches('[data-share-copy]')) {
        copyText(shareUrl()).then(() => showToast(t('linkCopied'))).catch(() => showToast(t('copyFailed')));
      } else if (item.matches('[data-share-native]')) {
        navigator.share({ title: document.title, url: shareUrl() }).catch(() => {});
      }
      close(false);
    });
    document.addEventListener('click', event => {
      if (!box.contains(event.target)) close(false);
    });
  });

  /* Build page: image language switch. Both languages are in the page; the URL follows the choice. */
  const imageSwitches = $$('[data-switch-image]');
  if (imageSwitches.length) {
    const syncImageSwitches = () => imageSwitches.forEach(link => {
      link.setAttribute('aria-current', String(link.dataset.switchImage === root.dataset.image));
    });
    syncImageSwitches();
    // On the shared /windows-NN address, name the shown language in the URL right away,
    // so a copied link opens the same image for whoever receives it.
    const shownLink = imageSwitches.find(link => link.dataset.switchImage === root.dataset.image);
    if (shownLink && !/-(en|ru)$/.test(location.pathname)) {
      history.replaceState(null, '', shownLink.getAttribute('href') + location.search + location.hash);
    }
    const showImage = lang => {
      const link = imageSwitches.find(l => l.dataset.switchImage === lang);
      root.dataset.image = lang;
      history.replaceState(null, '', link.getAttribute('href') + location.search + location.hash);
      syncImageSwitches();
    };
    imageSwitches.forEach(link => link.addEventListener('click', event => {
      event.preventDefault();
      showImage(link.dataset.switchImage);
    }));
    // Same as on the home page: switching the site language switches the image language too.
    languageListeners.push(showImage);
  }

  /* Build page: screenshot lightbox on a native dialog */
  const lightbox = $('#lightbox');
  if (lightbox && lightbox.showModal) {
    let shots = [];
    const image = $('img', lightbox);
    const counter = $('.lb-count', lightbox);
    let current = 0;

    // Full-size screenshots that are downloaded and decoded, by URL.
    const ready = new Set();
    const loading = new Map();
    function preload(url) {
      if (ready.has(url)) return Promise.resolve();
      if (!loading.has(url)) {
        const loader = new Image();
        loader.src = url;
        loading.set(url, loader.decode().then(() => { ready.add(url); }).finally(() => loading.delete(url)));
      }
      return loading.get(url);
    }

    function show(index) {
      resetZoom();
      current = (index + shots.length) % shots.length;
      const url = shots[current].href;
      const thumb = $('img', shots[current]);
      image.alt = thumb.alt;
      // Fixed proportions, so swapping the thumbnail for the full size does not change the size on screen.
      image.style.setProperty('--ar', thumb.getAttribute('width') / thumb.getAttribute('height'));
      counter.textContent = (current + 1) + ' / ' + shots.length;
      if (ready.has(url)) {
        image.src = url;
      } else {
        // Show the thumbnail the page already has at once, then swap in the full size when it is ready.
        image.src = thumb.currentSrc || thumb.src;
        preload(url).then(() => {
          if (shots[current] && shots[current].href === url) image.src = url;
        }).catch(() => {
          if (shots[current] && shots[current].href === url) image.src = url;
        });
      }
      // Fetch the neighbours too, so browsing on does not wait.
      [current + 1, current - 1].forEach(i => preload(shots[(i + shots.length) % shots.length].href).catch(() => {}));
    }

    // Each image language has its own gallery; browse only the one that was clicked.
    $$('.shot').forEach(shot => shot.addEventListener('click', event => {
      event.preventDefault();
      shots = $$('.shot', shot.closest('.gallery'));
      show(shots.indexOf(shot));
      lightbox.showModal();
    }));
    $('.lb-close', lightbox).addEventListener('click', () => lightbox.close());
    $('.lb-prev', lightbox).addEventListener('click', () => show(current - 1));
    $('.lb-next', lightbox).addEventListener('click', () => show(current + 1));
    lightbox.addEventListener('click', event => {
      if (event.target === lightbox) lightbox.close();
    });
    lightbox.addEventListener('keydown', event => {
      if (event.key === 'ArrowLeft') show(current - 1);
      if (event.key === 'ArrowRight') show(current + 1);
    });

    // Gestures on the screenshot, not the page. Touch: swipe left or right to browse, up or down to close,
    // pinch or double-tap to zoom, drag to move a zoomed screenshot. Mouse: wheel or double-click to zoom, drag to move.
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const EASE = '220ms cubic-bezier(.2, 0, 0, 1)';
    const MAX_ZOOM = 4;
    const DOUBLE_TAP_ZOOM = 2.5;
    const zoom = { s: 1, x: 0, y: 0 };
    const pointers = new Map();
    let gesture = null;
    let lastTap = null;
    let lastPointerType = 'mouse';
    let suppressClick = false;
    image.draggable = false;

    function setDrag(x, y, fade) {
      image.style.translate = x + 'px ' + y + 'px';
      lightbox.style.backgroundColor = fade === undefined ? '' : 'rgb(8 9 12 / ' + (0.94 * fade).toFixed(3) + ')';
    }
    function animate(apply, done) {
      const ms = reduceMotion.matches ? 0 : 220;
      image.style.transition = ms ? ['translate', 'transform', 'opacity'].map(p => p + ' ' + EASE).join(', ') : 'none';
      lightbox.style.transition = ms ? 'background-color ' + EASE : 'none';
      apply();
      setTimeout(() => {
        image.style.transition = lightbox.style.transition = '';
        if (done) done();
      }, ms);
    }
    function resetDrag() {
      image.style.transition = lightbox.style.transition = '';
      image.style.translate = image.style.opacity = '';
      lightbox.style.backgroundColor = '';
    }

    function applyZoom() {
      image.style.transform = zoom.s === 1 ? '' : 'translate(' + zoom.x + 'px, ' + zoom.y + 'px) scale(' + zoom.s + ')';
      lightbox.classList.toggle('is-zoomed', zoom.s > 1);
    }
    function resetZoom() {
      zoom.s = 1;
      zoom.x = zoom.y = 0;
      applyZoom();
    }
    // The image box as laid out, without the zoom.
    function baseRect() {
      const r = image.getBoundingClientRect();
      return { cx: r.left + r.width / 2 - zoom.x, cy: r.top + r.height / 2 - zoom.y, w: r.width / zoom.s, h: r.height / zoom.s };
    }
    // A zoomed screenshot moves only as far as its edges reach the edges of the screen.
    function clampPan(base) {
      const mx = Math.max(0, (base.w * zoom.s - window.innerWidth) / 2);
      const my = Math.max(0, (base.h * zoom.s - window.innerHeight) / 2);
      zoom.x = Math.min(mx, Math.max(-mx, zoom.x));
      zoom.y = Math.min(my, Math.max(-my, zoom.y));
    }
    // Zoom to `s`, keeping the point under (px, py) in place.
    function zoomAt(s, px, py, base) {
      base = base || baseRect();
      s = Math.min(MAX_ZOOM, Math.max(1, s));
      zoom.x = px - base.cx - (px - base.cx - zoom.x) * s / zoom.s;
      zoom.y = py - base.cy - (py - base.cy - zoom.y) * s / zoom.s;
      zoom.s = s;
      if (s === 1) zoom.x = zoom.y = 0;
      else clampPan(base);
      applyZoom();
    }
    function toggleZoom(px, py) {
      animate(() => (zoom.s > 1 ? resetZoom() : zoomAt(DOUBLE_TAP_ZOOM, px, py)));
    }
    // After a pinch: back to the allowed zoom range and inside the edges.
    function settleZoom(base) {
      animate(() => {
        if (zoom.s <= 1.02) return resetZoom();
        zoom.s = Math.min(MAX_ZOOM, zoom.s);
        clampPan(base);
        applyZoom();
      });
    }
    function swallowClick() {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
    }

    lightbox.addEventListener('close', () => {
      pointers.clear();
      gesture = lastTap = null;
      resetDrag();
      resetZoom();
    });

    function startSingle(event) {
      const start = { id: event.pointerId, x: event.clientX, y: event.clientY, t: event.timeStamp, moved: false };
      gesture = zoom.s > 1
        ? Object.assign(start, { type: 'pan', x0: zoom.x, y0: zoom.y, base: baseRect() })
        : Object.assign(start, { type: 'swipe', dx: 0, dy: 0, axis: null });
    }
    function startPinch() {
      if (gesture && gesture.type === 'swipe') setDrag(0, 0);
      const [a, b] = Array.from(pointers.values());
      gesture = {
        type: 'pinch',
        d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        s0: zoom.s, x0: zoom.x, y0: zoom.y, base: baseRect(),
      };
    }

    lightbox.addEventListener('pointerdown', event => {
      lastPointerType = event.pointerType;
      if (event.target.closest('.lb-btn')) return;
      // The mouse drags only a zoomed screenshot; browsing is on the buttons and arrow keys.
      if (event.pointerType === 'mouse' && (event.button !== 0 || zoom.s === 1)) return;
      if (event.pointerType === 'mouse') event.preventDefault();
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      image.style.transition = lightbox.style.transition = 'none';
      if (pointers.size === 2) startPinch();
      else if (pointers.size === 1) startSingle(event);
    });

    lightbox.addEventListener('pointermove', event => {
      const point = pointers.get(event.pointerId);
      if (!point || !gesture) return;
      point.x = event.clientX;
      point.y = event.clientY;
      if (gesture.type === 'pinch') {
        if (pointers.size < 2) return;
        const [a, b] = Array.from(pointers.values());
        const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const s = Math.min(MAX_ZOOM * 1.25, Math.max(0.6, gesture.s0 * Math.hypot(a.x - b.x, a.y - b.y) / gesture.d0));
        zoom.x = m.x - gesture.base.cx - (gesture.m0.x - gesture.base.cx - gesture.x0) * s / gesture.s0;
        zoom.y = m.y - gesture.base.cy - (gesture.m0.y - gesture.base.cy - gesture.y0) * s / gesture.s0;
        zoom.s = s;
        image.style.transform = 'translate(' + zoom.x + 'px, ' + zoom.y + 'px) scale(' + s + ')';
        return;
      }
      if (event.pointerId !== gesture.id) return;
      const dx = event.clientX - gesture.x;
      const dy = event.clientY - gesture.y;
      if (Math.hypot(dx, dy) > 8) gesture.moved = true;
      if (gesture.type === 'pan') {
        zoom.x = gesture.x0 + dx;
        zoom.y = gesture.y0 + dy;
        clampPan(gesture.base);
        applyZoom();
        return;
      }
      gesture.dx = dx;
      gesture.dy = dy;
      if (!gesture.axis && gesture.moved) gesture.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (gesture.axis === 'x') setDrag(dx, 0);
      if (gesture.axis === 'y') setDrag(0, dy, Math.max(0.3, 1 - Math.abs(dy) / 400));
    });

    function tap(event) {
      if (event.pointerType === 'mouse') return;
      const isDouble = lastTap && event.timeStamp - lastTap.t < 300
        && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 30;
      if (isDouble) {
        lastTap = null;
        swallowClick();
        toggleZoom(event.clientX, event.clientY);
      } else {
        lastTap = { t: event.timeStamp, x: event.clientX, y: event.clientY };
      }
    }

    function endSwipe(event, g) {
      const { axis, dx, dy, t } = g;
      const distance = axis === 'x' ? dx : dy;
      const speed = Math.abs(distance) / Math.max(1, event.timeStamp - t);
      const passed = event.type === 'pointerup' && (Math.abs(distance) > 60 || (speed > 0.5 && Math.abs(distance) > 20));
      if (!passed) return animate(() => setDrag(0, 0));
      if (axis === 'y') {
        const away = (dy > 0 ? 1 : -1) * window.innerHeight;
        return animate(() => { setDrag(0, away, 0); image.style.opacity = '0'; }, () => lightbox.close());
      }
      // The next image comes in from the side the finger moved away from.
      const step = dx < 0 ? 1 : -1;
      animate(() => { setDrag(-step * window.innerWidth, 0); image.style.opacity = '0'; }, () => {
        image.style.transition = 'none';
        show(current + step);
        setDrag(step * 60, 0);
        image.offsetWidth; // apply the start position before animating in
        animate(() => { setDrag(0, 0); image.style.opacity = ''; });
      });
    }

    function endPointer(event) {
      if (!pointers.delete(event.pointerId) || !gesture) return;
      const g = gesture;
      if (g.type === 'pinch') {
        swallowClick();
        lastTap = null;
        settleZoom(g.base);
        // One finger still down: it goes on moving the zoomed screenshot.
        const [rest] = Array.from(pointers.entries());
        gesture = null;
        if (rest && zoom.s > 1.02) {
          gesture = { type: 'pan', id: rest[0], x: rest[1].x, y: rest[1].y, t: event.timeStamp, moved: true, x0: zoom.x, y0: zoom.y, base: g.base };
        }
        return;
      }
      if (event.pointerId !== g.id) return;
      gesture = null;
      if (!g.moved) {
        if (g.type === 'swipe') resetDrag();
        return tap(event);
      }
      swallowClick();
      lastTap = null;
      if (g.type === 'swipe' && g.axis) endSwipe(event, g);
    }
    lightbox.addEventListener('pointerup', endPointer);
    lightbox.addEventListener('pointercancel', endPointer);

    // Mouse: double-click zooms in at the cursor and back out; the wheel zooms smoothly.
    image.addEventListener('dblclick', event => {
      if (lastPointerType === 'mouse') toggleZoom(event.clientX, event.clientY);
    });
    lightbox.addEventListener('wheel', event => {
      event.preventDefault();
      image.style.transition = 'none';
      zoomAt(zoom.s * Math.exp(-event.deltaY * 0.002), event.clientX, event.clientY);
    }, { passive: false });

    // A swipe, pinch or drag must not count as a tap on the backdrop.
    lightbox.addEventListener('click', event => {
      if (suppressClick) event.stopImmediatePropagation();
    }, true);
  }

  /* Build page: on small screens, show the download bar once the panel scrolls away */
  const panel = $('.panel');
  const bar = $('.dl-bar');
  if (panel && bar && 'IntersectionObserver' in window) {
    bar.hidden = true;
    new IntersectionObserver(entries => {
      bar.hidden = entries[0].isIntersecting || entries[0].boundingClientRect.top > 0;
    }).observe(panel);
  }

  /* Settings: search and category filter */
  const search = $('#settings-search');
  if (search) {
    const items = $$('.item');
    const groups = $$('.group');
    const chips = $$('.chip');
    const count = $('#result-count');
    const empty = $('#empty');
    let category = 'all';

    function applyFilter() {
      const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
      let visible = 0;
      items.forEach(item => {
        const inCategory = category === 'all' || item.dataset.category === category;
        const matches = words.every(word => item.dataset.search.includes(word));
        item.hidden = !(inCategory && matches);
        if (!item.hidden) visible += 1;
      });
      groups.forEach(group => {
        group.hidden = !$$('.item', group).some(item => !item.hidden);
      });
      empty.hidden = visible > 0;
      count.textContent = t('found') + ': ' + visible;
    }

    search.addEventListener('input', applyFilter);
    chips.forEach(chip => chip.addEventListener('click', () => {
      category = chip.dataset.category;
      chips.forEach(other => other.setAttribute('aria-pressed', String(other === chip)));
      applyFilter();
    }));
    languageListeners.push(applyFilter);
    applyFilter();
  }
})();
