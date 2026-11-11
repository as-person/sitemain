(function () {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const root = document.documentElement;

  const STRINGS = {
    en: { copied: 'Copied', copyFailed: 'Could not copy', found: 'Found', clicks: 'Downloads', download: 'Download', linkCopied: 'Link copied', copies: 'Copies', linkClicks: 'Link clicks', tgClicks: 'Telegram clicks', fromHere: 'from here', views: 'Page views', today: 'today', week: '7 days', month: '30 days', total: 'all time', allCount: 'total', people: 'people', repeated: 'repeated', sum: 'Total', onlyYou: 'visible only to you', viaKey: 'signed in by key', shareMenu: 'Share menu', shareOpened: 'opened', shared: 'shared', share_open: 'Opened the menu', share_copy: 'Copy link', share_native: 'Other apps', share_vk: 'VK' },
    ru: { copied: 'Скопировано', copyFailed: 'Не удалось скопировать', found: 'Найдено', clicks: 'Скачиваний', download: 'Скачать', linkCopied: 'Ссылка скопирована', copies: 'Копирований', linkClicks: 'Переходов', tgClicks: 'Переходов в Telegram', fromHere: 'отсюда', views: 'Просмотры страницы', today: 'сегодня', week: 'неделя', month: 'месяц', total: 'за всё время', allCount: 'всего', people: 'людей', repeated: 'повторно', sum: 'Итого', onlyYou: 'видно только вам', viaKey: 'вход по ключу', shareMenu: 'Меню «Поделиться»', shareOpened: 'открыли', shared: 'поделились', share_open: 'Открыли меню', share_copy: 'Скопировать ссылку', share_native: 'Другие приложения', share_vk: 'ВКонтакте' },
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
  // On the owner's own device (opened once with /?owner=<token>, see `analytics` in _src/build.mjs) every request
  // carries the token: the counter shows the stats and does not count the owner, on any network.
  const withOwner = url => (window.ownerToken ? url + (url.includes('?') ? '&' : '?') + 'owner=' + encodeURIComponent(window.ownerToken) : url);
  // Sends a counter request that survives leaving the page
  const ping = url => {
    if (!(navigator.sendBeacon && navigator.sendBeacon(url))) fetch(url, { method: 'POST', mode: 'no-cors', keepalive: true }).catch(() => {});
  };
  // The page as the counter knows it: /ru copies and the -en / -ru build addresses are the same page
  const pagePathNow = () => (location.pathname.toLowerCase()
    .replace(/\.html$/, '').replace(/\/index$/, '/').replace(/^\/ru(?=\/|$)/, '')
    .replace(/^(\/windows-1[01])-(en|ru)$/, '$1').replace(/(.)\/+$/, '$1')) || '/';

  function reportClick(event) {
    const link = event.target.closest && event.target.closest('[data-count-file], [data-count-tweak]');
    if (!link) return;
    const target = link.dataset.countTweak ? 'tweak=' + link.dataset.countTweak : 'file=' + encodeURIComponent(link.dataset.countFile);
    const url = withOwner(COUNTER + '/count?' + target + '&kind=' + link.dataset.countKind);
    if (!(navigator.sendBeacon && navigator.sendBeacon(url))) {
      fetch(url, { method: 'POST', mode: 'no-cors', keepalive: true }).catch(() => {});
    }
  }
  document.addEventListener('click', reportClick);
  document.addEventListener('auxclick', event => {
    if (event.button === 1) reportClick(event);
  });

  let statsCounts = null;
  // Owner stats: a short line with the unique count (one person once a day), and on click a small table
  // "people / total / repeated" with every action. The open state survives re-rendering (language switch).
  function statDetails(host, summary, rows, sumRow) {
    const wasOpen = !!$('details[open]', host);
    const details = document.createElement('details');
    details.className = 'owner-stat';
    details.open = wasOpen;
    const head = document.createElement('summary');
    head.textContent = summary;
    const table = document.createElement('table');
    const cells = (tag, values) => {
      const tr = document.createElement('tr');
      values.forEach((value, i) => {
        const cell = document.createElement(i === 0 ? 'th' : tag);
        cell.textContent = value;
        tr.append(cell);
      });
      return tr;
    };
    const list = rows.concat(sumRow && rows.length > 1 ? [{
      label: t('sum'), unique: rows.reduce((n, r) => n + r.unique, 0), all: rows.reduce((n, r) => n + r.all, 0), sum: true,
    }] : []);
    table.append(cells('th', ['', t('people'), t('allCount'), t('repeated')]),
      ...list.map(r => {
        const tr = cells('td', [r.label, r.unique, Math.max(r.all, r.unique), Math.max(r.all - r.unique, 0)]);
        if (r.sum) tr.className = 'sum';
        return tr;
      }));
    details.append(head, table);
    host.replaceChildren(details);
  }

  function renderStats() {
    if (!statsCounts) return;
    $$('[data-stats-file]').forEach(line => {
      const counts = statsCounts[line.dataset.statsFile] || {};
      const parts = line.dataset.statsKinds.split(',').map(kind => ({
        label: kind === 'download' ? t('download') : kind === 'torrent' ? 'Torrent' : 'Magnet',
        value: counts[kind] || 0,
        all: counts['all:' + kind] || 0,
      }));
      const total = parts.reduce((sum, part) => sum + part.value, 0);
      statDetails(line, t('clicks') + ': ' + total, parts.map(part => ({ label: part.label, unique: part.value, all: part.all })), true);
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
        all: { download: own['all:download'] || 0, copy: own['all:copy'] || 0, link: own['all:link'] || 0 },
      };
    };
    const kindLabel = kind => t(kind === 'download' ? 'clicks' : kind === 'copy' ? 'copies' : 'linkClicks');
    const tweakText = (line, numbers) => line.dataset.kinds.split(',').map(kind => kindLabel(kind) + ': ' + numbers[kind]).join(' · ');
    $$('[data-tweak-stats]').forEach(line => {
      const numbers = tweakNumbers(line);
      statDetails(line, tweakText(line, numbers), line.dataset.kinds.split(',')
        .map(kind => ({ label: kindLabel(kind), unique: numbers[kind], all: numbers.all[kind] })), false);
      line.hidden = false;
    });

    // Telegram cards: clicks on any channel link on the site, and on this card's place
    $$('[data-tg-stats]').forEach(line => {
      const site = statsCounts.tg || {};
      const here = statsCounts['tg:' + line.dataset.tgStats] || {};
      statDetails(line, t('tgClicks') + ': ' + (site.click || 0) + ' · ' + t('fromHere') + ' ' + (here.click || 0), [
        { label: t('tgClicks'), unique: site.click || 0, all: site['all:click'] || 0 },
        { label: t('fromHere'), unique: here.click || 0, all: here['all:click'] || 0 },
      ], false);
      line.hidden = false;
    });

    // Share menu of this page: opened, and what was chosen in it
    $$('[data-share-stats]').forEach(line => {
      const counts = statsCounts['share:' + pagePathNow()] || {};
      const actions = ['open', 'copy', 'native', 'telegram', 'whatsapp', 'vk', 'x', 'facebook', 'reddit', 'email'];
      const names = { telegram: 'Telegram', whatsapp: 'WhatsApp', x: 'X', facebook: 'Facebook', reddit: 'Reddit', email: 'Email' };
      const shared = actions.slice(1).reduce((n, a) => n + (counts[a] || 0), 0);
      statDetails(line, t('shareMenu') + ': ' + t('shareOpened') + ' ' + (counts.open || 0) + ' · ' + t('shared') + ' ' + shared,
        actions.filter(a => a === 'open' || counts[a] || counts['all:' + a])
          .map(a => ({ label: names[a] || t('share_' + a), unique: counts[a] || 0, all: counts['all:' + a] || 0 })), false);
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
  if ($('[data-stats-file], [data-tweak-stats], [data-tg-stats], [data-share-stats]')) {
    languageListeners.push(renderStats);
    // The page asks the counter once, in <head>; see `analytics` in _src/build.mjs.
    (window.siteOwner || fetch(withOwner(COUNTER + '/stats')).then(response => response.json()))
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
    const pagePath = pagePathNow();
    if (/^\/[a-z0-9/-]{0,100}$/.test(pagePath)) {
      const url = withOwner(COUNTER + '/count?page=' + encodeURIComponent(pagePath) + '&kind=view');
      if (!(navigator.sendBeacon && navigator.sendBeacon(url))) {
        fetch(url, { method: 'POST', mode: 'no-cors', keepalive: true }).catch(() => {});
      }
      (window.siteOwner || fetch(withOwner(COUNTER + '/stats')).then(response => response.json()))
        .then(data => {
          const topbar = $('.topbar');
          if (!data.owner || !topbar) return;
          const views = data.counts['page:' + pagePath] || {};
          const bar = document.createElement('div');
          bar.className = 'page-views';
          bar.innerHTML = '<div class="container"></div>';
          const render = () => {
            const periods = [['today', 'today'], ['week', 'week'], ['month', 'month'], ['total', '']];
            const summary = t('views') + ': ' + periods.map(([label, key]) => t(label) + ' ' + (views[key || 'view'] || 0)).join(' · ')
              + ' (' + t('onlyYou') + ')'
              // Recognized by the device key, not the IP: normal on a phone, on the home PC it means the IP changed
              + (data.via === 'token' ? ' · ' + t('viaKey') : '');
            statDetails(bar.firstChild, summary, periods.map(([label, key]) => ({
              label: t(label), unique: views[key || 'view'] || 0, all: views[key ? 'hits_' + key : 'hits'] || 0,
            })), false);
          };
          render();
          languageListeners.push(render);
          // Wide screens: over the top padding of <main> (see .page-views in site.css), so it moves nothing on the page.
          // Phones: right under the header; inside <main> it would sit below main's top padding, with a gap above it.
          const narrow = matchMedia('(max-width: 720px)');
          const placeBar = () => {
            if (narrow.matches || !$('main')) topbar.after(bar);
            else $('main').prepend(bar);
          };
          placeBar();
          narrow.addEventListener('change', placeBar);
        })
        .catch(() => {});
    }
  }

  /* Header links on a phone: fade the right edge while there is more of the row to scroll to */
  const nav = $('.site-nav');
  if (nav) {
    const fade = () => nav.classList.toggle('is-scrollable', nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 2);
    // Keep the word "Telegram" whenever the row fits with it; switch to the plane icon only if it does not
    const fitTelegram = () => {
      nav.classList.remove('tg-icon-only');
      if (nav.scrollWidth > nav.clientWidth + 1) nav.classList.add('tg-icon-only');
      fade();
    };
    fitTelegram();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitTelegram);
    nav.addEventListener('scroll', fade, { passive: true });
    addEventListener('resize', fitTelegram);
    languageListeners.push(fitTelegram);
  }

  /* Header "Builds" menu (a <details>, so it works without scripts too). Closes on a click outside or Esc.
     On phones the nav row scrolls sideways and would clip it, so there it is placed under the button by hand. */
  $$('[data-nav-menu]').forEach(menu => {
    const list = $('.nav-menu-list', menu);
    const place = () => {
      if (!menu.open || !matchMedia('(max-width: 720px)').matches) {
        list.style.cssText = '';
        return;
      }
      const r = $('summary', menu).getBoundingClientRect();
      const width = Math.min(260, innerWidth - 32);
      list.style.cssText = `position: fixed; top: ${r.bottom + 6}px; left: ${Math.max(16, Math.min(r.left, innerWidth - width - 16))}px; min-width: ${width}px;`;
    };
    // Opening it may scroll the nav row or the page a little to show the button: that must not close it
    let openedAt = 0;
    menu.addEventListener('toggle', () => { if (menu.open) openedAt = Date.now(); place(); });
    addEventListener('resize', place);
    addEventListener('scroll', () => {
      if (!menu.open || !matchMedia('(max-width: 720px)').matches) return;
      if (Date.now() - openedAt < 500) place(); else menu.open = false;
    }, { passive: true });
    // Scrolling the nav row sideways keeps the menu under its button
    $('.site-nav') && $('.site-nav').addEventListener('scroll', place, { passive: true });
    document.addEventListener('click', event => { if (menu.open && !menu.contains(event.target)) menu.open = false; });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && menu.open) { menu.open = false; $('summary', menu).focus(); }
    });
  });

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
      // "Download English ISO" / "Download Russian ISO": the button names the chosen image language
      $$('[data-dl-label]').forEach(label => { label.hidden = label.dataset.dlLabel !== imageLang; });
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
    const url = withOwner(COUNTER + '/count?tg=' + link.dataset.tgPlacement + '&kind=click');
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
    // Owner-only stats: the menu was opened, and what was chosen in it
    const report = action => ping(withOwner(COUNTER + '/count?share=' + action + '&on=' + encodeURIComponent(pagePathNow()) + '&kind=click'));
    function open() {
      report('open');
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
      report(item.dataset.shareService || (item.matches('[data-share-copy]') ? 'copy' : 'native'));
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
    // The bar stays in the page and slides in and out (CSS .is-shown) instead of appearing at once
    bar.hidden = false;
    new IntersectionObserver(entries => {
      bar.classList.toggle('is-shown', !(entries[0].isIntersecting || entries[0].boundingClientRect.top > 0));
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

  /* Chat with the author: messages go to dl.somov.org (_src/chat/server.py), a Telegram bot brings them to the
     owner, and his Telegram replies come back here. A visitor is a random id kept in this browser. */
  const CHAT = 'https://dl.somov.org/api/chat';
  const CHAT_TEXT = {
    en: { title: 'somov', sub: 'ask a question', contact: 'Your email for a reply', placeholder: 'Message', send: 'Send', close: 'Close', today: 'Today', yesterday: 'Yesterday', failed: 'Not sent. Tap to retry', limit: 'Too many messages. Try again a bit later.', attach: 'Attach a photo or file', tooLarge: 'The file is larger than 10 MB', kb: 'KB', mb: 'MB', notify: 'Let me know when the answer comes', notifyHint: 'A notification will come even if the site is closed', pushOn: 'Notifications are on', pushDenied: 'Notifications are blocked in the browser settings', pushFailed: 'Could not turn notifications on', contactToggle: 'Email for a reply', contactSave: 'Save', contactHide: 'Hide', contactSaved: 'Contact saved', contactRemoved: 'Contact removed', contactLater: 'The contact will go with your first message', contactFailed: 'Could not save the contact', pushOnHint: 'Notifications are on. They can be turned off in the browser settings', unread: 'New answers', introHead: 'Ask a question and we will answer here.', introText: 'If you close the site, the answer is easy to miss. Leave your email and confirm it from the letter — we will send the answer there too.', introButton: 'Leave your email', contactBad: 'This does not look like an email', verifyHint: 'Confirm your email with the link in the letter — then the answer will come there too' },
    ru: { title: 'somov', sub: 'задайте вопрос', contact: 'Ваша почта для ответа', placeholder: 'Сообщение', send: 'Отправить', close: 'Закрыть', today: 'Сегодня', yesterday: 'Вчера', failed: 'Не отправлено. Нажмите, чтобы повторить', limit: 'Слишком много сообщений. Попробуйте чуть позже.', attach: 'Прикрепить фото или файл', tooLarge: 'Файл больше 10 МБ', kb: 'КБ', mb: 'МБ', notify: 'Сообщить, когда придёт ответ', notifyHint: 'Уведомление придёт, даже если сайт будет закрыт', pushOn: 'Уведомления включены', pushDenied: 'Уведомления запрещены в настройках браузера', pushFailed: 'Не удалось включить уведомления', contactToggle: 'Почта для ответа', contactSave: 'Сохранить', contactHide: 'Скрыть', contactSaved: 'Контакт сохранён', contactRemoved: 'Контакт удалён', contactLater: 'Контакт уйдёт вместе с первым сообщением', contactFailed: 'Не удалось сохранить контакт', pushOnHint: 'Уведомления включены. Выключить их можно в настройках браузера', unread: 'Новые ответы', introHead: 'Напишите вопрос — мы ответим здесь.', introText: 'Если закроете сайт, ответ легко пропустить. Оставьте почту и подтвердите её по ссылке из письма — продублируем ответ туда.', introButton: 'Оставить почту', contactBad: 'Это не похоже на адрес почты', verifyHint: 'Подтвердите почту по ссылке из письма — тогда ответ придёт и туда' },
  };
  const openers = $$('[data-chat-open]');
  if (openers.length) {
    const ct = key => CHAT_TEXT[currentLang()][key];
    const store = {
      get: key => { try { return localStorage.getItem(key); } catch (e) { return null; } },
      set: (key, value) => { try { localStorage.setItem(key, value); } catch (e) {} },
    };
    // ?chatreset: this browser forgets its conversation and chat settings, as a first-time visitor (for testing)
    if (new URLSearchParams(location.search).has('chatreset')) {
      ['chatVisitor', 'chatSeen', 'chatContact', 'chatContactBar', 'chatPush', 'chatPushOffer', 'chatLastSent']
        .forEach(key => { try { localStorage.removeItem(key); } catch (e) {} });
      history.replaceState(null, '', location.pathname + location.hash);
    }
    const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
    let visitor = store.get('chatVisitor');
    let lastId = 0;           // newest message id shown
    let hasContact = false;
    let verified = false;     // the email in the chat is confirmed from its mailbox (answers go there too)
    let panel = null;
    let pollTimer = null;
    let lastOpener = null;
    const messages = [];      // {id, owner, text, t, state}

    const seenId = () => Number(store.get('chatSeen') || 0);

    function fetchNew() {
      if (!visitor) return Promise.resolve([]);
      return fetch(`${CHAT}/messages?v=${visitor}&after=${lastId}`, { cache: 'no-store' })
        .then(r => r.json())
        .then(data => {
          hasContact = data.contact;
          verified = !!data.verified;
          const fresh = data.messages.filter(m => m.id > lastId && !messages.some(x => x.id === m.id));
          fresh.forEach(m => messages.push(m));
          if (data.messages.length) lastId = Math.max(lastId, ...data.messages.map(m => m.id));
          return fresh;
        });
    }

    const pad = n => String(n).padStart(2, '0');
    const timeOf = t => { const d = new Date(t * 1000); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
    function dayOf(t) {
      const d = new Date(t * 1000);
      const start = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
      const diff = Math.round((start(new Date()) - start(d)) / 86400000);
      if (diff === 0) return ct('today');
      if (diff === 1) return ct('yesterday');
      return d.toLocaleDateString(currentLang() === 'ru' ? 'ru-RU' : 'en-GB', { day: 'numeric', month: 'long' });
    }

    function render() {
      if (!panel) return;
      const list = $('.chat-list', panel);
      const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
      list.textContent = '';
      let day = '';
      // What the visitor should know: the answer comes here, and a contact keeps it from being missed
      if (!hasContact && !savedContact()) list.append(introNode());   // a contact saved before the first message counts too
      // The email is on the server but not confirmed yet: a quiet reminder, until the visitor confirms it
      else if (hasContact && !verified) {
        const remind = document.createElement('div');
        remind.className = 'chat-verify';
        remind.textContent = '📩 ' + ct('verifyHint');
        list.append(remind);
      }
      // The notification offer stays right under the visitor's first message: new messages go below it
      const offerAfter = pushOffer() && store.get('chatPushOffer') !== 'done' ? messages.find(m => !m.owner && m.id) : null;
      messages.forEach(m => {
        const label = dayOf(m.t);
        if (label !== day) {
          day = label;
          const sep = document.createElement('div');
          sep.className = 'chat-day';
          sep.textContent = label;
          list.append(sep);
        }
        const bubble = document.createElement('div');
        bubble.className = 'chat-msg ' + (m.owner ? 'is-in' : 'is-out') + (m.state === 'failed' ? ' is-failed' : '')
          + (m.file && m.file.image ? ' has-photo' : '');
        if (m.file) bubble.append(fileNode(m, nearBottom || !render.done));
        if (m.text) {
          const text = document.createElement('span');
          text.className = 'chat-text';
          text.textContent = m.text;
          bubble.append(text);
        }
        const meta = document.createElement('span');
        meta.className = 'chat-meta';
        meta.textContent = timeOf(m.t) + (m.owner ? '' : m.state === 'sending' ? ' 🕓' : m.state === 'failed' ? ' !' : ' ✓');
        bubble.append(meta);
        if (m.state === 'failed') {
          bubble.title = ct('failed');
          bubble.setAttribute('role', 'button');
          bubble.tabIndex = 0;
          bubble.addEventListener('click', () => (m.blob ? sendFile(m) : sendMessage(m)));
        }
        list.append(bubble);
        if (m === offerAfter) list.append(offerNode());
      });
      contactUi();
      bellUi();
      if (nearBottom || !render.done) list.scrollTop = list.scrollHeight;
      render.done = true;
      const ownerIds = messages.filter(m => m.owner).map(m => m.id);
      if (ownerIds.length) store.set('chatSeen', String(Math.max(seenId(), ...ownerIds)));
      updateUnread();
    }

    function introNode() {
      const intro = document.createElement('div');
      intro.className = 'chat-intro';
      const head = document.createElement('b');
      head.textContent = ct('introHead');
      const text = document.createElement('span');
      text.textContent = ct('introText');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '✉️ ' + ct('introButton');
      button.addEventListener('click', () => setContact(true, true));
      intro.append(head, text);
      if (!contactShown()) intro.append(button);   // the bar is folded: the button brings it back
      return intro;
    }

    function offerNode() {
      const offer = document.createElement('div');
      offer.className = 'chat-notify';
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = '🔔 ' + ct('notify');
      button.addEventListener('click', () => enablePush(button));
      const hint = document.createElement('span');
      hint.textContent = ct('notifyHint');
      offer.append(button, hint);
      // Shown once: in 20 s it goes into the bell in the header, which keeps the same offer
      if (!pushOfferTimer) {
        pushOfferTimer = setTimeout(() => {
          store.set('chatPushOffer', 'done');
          render();
          pulse($('.chat-bell', panel));
        }, 20000);
      }
      return offer;
    }

    // Browser notifications about answers (Web Push through /sw.js): offered after the visitor's first message,
    // asked for only when they press the button. iPhones have it only for a site added to the Home Screen.
    const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    const pushOffer = () => pushSupported && Notification.permission !== 'denied' && store.get('chatPush') !== '1'
      && messages.some(m => !m.owner && m.id);
    let pushOfferTimer = null;

    // The bell in the header: there once the conversation started (and the browser can do it);
    // a green dot when notifications are on
    function bellUi() {
      const bell = $('.chat-bell', panel);
      bell.hidden = !pushSupported || Notification.permission === 'denied' || !messages.some(m => !m.owner && m.id);
      bell.classList.toggle('is-set', store.get('chatPush') === '1' && Notification.permission === 'granted');
    }

    function pulse(element) {
      if (!element || element.hidden) return;
      element.classList.remove('is-pulse');
      void element.offsetWidth;   // restart the animation
      element.classList.add('is-pulse');
    }

    function enablePush(button) {
      button.disabled = true;
      const done = () => { button.disabled = false; };
      const keyBytes = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - text.length % 4) % 4)), c => c.charCodeAt(0));
      Notification.requestPermission()
        .then(permission => {
          if (permission !== 'granted') throw new Error('denied');
          return Promise.all([navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready),
            fetch(`${CHAT}/push-key`).then(r => r.json())]);
        })
        .then(([registration, data]) => registration.pushManager.getSubscription()
          .then(old => old || registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(data.key) })))
        .then(subscription => fetch(`${CHAT}/subscribe?v=${visitor}`, {
          method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(subscription),
        }))
        .then(r => {
          if (!r.ok) throw new Error('subscribe');
          store.set('chatPush', '1');
          store.set('chatPushOffer', 'done');
          showToast(ct('pushOn'));
          done();
          render();
        })
        .catch(() => {
          showToast(Notification.permission === 'denied' ? ct('pushDenied') : ct('pushFailed'));
          done();
          render();
        });
    }
    if (pushSupported) {
      navigator.serviceWorker.addEventListener('message', event => {
        if (event.data && event.data.chat === 'open') open();
      });
    }

    /* Contact for an answer by email or Telegram: a bar under the header, like a pinned message in Telegram.
       It is open until the visitor saves a contact or hides it; after the first message without a contact it
       folds by itself in 30 s. The envelope in the header brings it back at any time (a green dot: saved). */
    let contactOpen = null;   // null: decided by the rules above; true / false: the visitor chose
    let contactTimer = null;
    const savedContact = () => store.get('chatContact') || '';
    const hasThread = () => messages.some(m => !m.owner && m.id);
    // What goes with the next message: a contact typed or saved but not yet on the server
    const looksLikeEmail = text => /^[^@\s<>"]+@[^@\s<>"]+\.[A-Za-z]{2,}$/.test(text);
    const pendingContact = () => {
      if (hasContact) return '';
      const typed = $('.chat-contact', panel).value.trim();
      return looksLikeEmail(typed) ? typed : (looksLikeEmail(savedContact()) ? savedContact() : '');
    };

    function contactShown() {
      if (contactOpen !== null) return contactOpen;
      return !hasContact && !savedContact() && store.get('chatContactBar') !== 'closed';
    }

    function contactUi() {
      const bar = $('.chat-contact-bar', panel);
      const shown = contactShown();
      if (shown && bar.hidden) $('.chat-contact', panel).value = savedContact();
      bar.hidden = !shown;
      const toggle = $('.chat-contact-toggle', panel);
      toggle.classList.toggle('is-set', hasContact || !!savedContact());
      toggle.setAttribute('aria-expanded', String(shown));
    }

    function setContact(open, focus) {
      contactOpen = open;
      clearTimeout(contactTimer);
      if (!open) store.set('chatContactBar', 'closed');
      render();   // also shows or hides the button in the intro
      if (open && focus) $('.chat-contact', panel).focus();
    }

    // After a message: the bar is not needed now, fold it soon (unless the visitor is typing in it)
    function foldContactLater() {
      if (contactTimer || !contactShown() || hasContact) return;
      contactTimer = setTimeout(() => {
        const field = $('.chat-contact', panel);
        if (!contactShown() || document.activeElement === field || field.value.trim()) return;
        setContact(false);
        pulse($('.chat-contact-toggle', panel));
      }, 30000);
    }

    function saveContact() {
      const value = $('.chat-contact', panel).value.trim().slice(0, 120);
      // Only an email: answers are sent there (an empty field removes the contact)
      if (value && !looksLikeEmail(value)) {
        showToast(ct('contactBad'));
        $('.chat-contact', panel).focus();
        return;
      }
      store.set('chatContact', value);
      if (!hasThread()) {   // no conversation yet: it goes with the first message
        setContact(false);
        if (value) showToast(ct('contactLater'));
        return;
      }
      fetch(`${CHAT}/contact?v=${visitor}`, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify({ contact: value }) })
        .then(r => {
          if (!r.ok) throw new Error('contact');
          hasContact = !!value;
          setContact(false);
          showToast(ct(value ? 'contactSaved' : 'contactRemoved'));
        })
        .catch(() => showToast(ct('contactFailed')));
    }

    function sendMessage(m) {
      m.state = 'sending';
      render();
      const sentContact = pendingContact();
      const body = JSON.stringify({
        v: visitor, text: m.text, contact: sentContact,
        page: location.pathname, lang: currentLang(), website: $('.chat-hp', panel).value,
      });
      // text/plain keeps it a simple request: no CORS preflight
      fetch(`${CHAT}/send`, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body })
        .then(r => r.json().then(data => ({ ok: r.ok, status: r.status, data })))
        .then(({ ok, status, data }) => {
          if (!ok) {
            m.state = 'failed';
            if (status === 429) showToast(ct('limit'));
            return render();
          }
          m.state = '';
          m.id = data.id;
          m.t = data.t;
          lastId = Math.max(lastId, data.id);
          sentWith(sentContact);
          render();
        })
        .catch(() => { m.state = 'failed'; render(); });
    }

    // After a message reached the server: remember the visitor, the contact that went with it, fold the bar
    function sentWith(sentContact) {
      if (sentContact) {
        hasContact = true;
        store.set('chatContact', sentContact);
        if (contactShown()) setContact(false);
      }
      store.set('chatVisitor', visitor);
      store.set('chatLastSent', String(Date.now()));
      foldContactLater();
    }

    const fileUrl = file => `${CHAT}/file/${file.id}?v=${visitor}`;
    const sizeText = size => (size >= 1048576 ? (size / 1048576).toFixed(1) + ' ' + ct('mb') : Math.max(1, Math.round(size / 1024)) + ' ' + ct('kb'));

    // A picture is shown in the bubble (the local copy while it uploads); any other file is a download card
    function fileNode(m, stick) {
      const file = m.file;
      const link = document.createElement('a');
      if (file.id) {
        link.href = fileUrl(file);
        link.target = '_blank';
        link.rel = 'noopener';
      }
      if (file.image) {
        link.className = 'chat-photo';
        const img = document.createElement('img');
        img.alt = file.name;
        img.src = file.local || fileUrl(file);
        if (stick) img.addEventListener('load', () => { const list = $('.chat-list', panel); list.scrollTop = list.scrollHeight; });
        link.append(img);
      } else {
        link.className = 'chat-file';
        if (file.id) link.download = file.name;
        const badge = document.createElement('span');
        badge.className = 'chat-file-icon';
        badge.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/></svg>';
        const info = document.createElement('span');
        info.className = 'chat-file-info';
        const name = document.createElement('b');
        name.textContent = file.name;
        const size = document.createElement('span');
        size.textContent = sizeText(file.size);
        info.append(name, size);
        link.append(badge, info);
      }
      return link;
    }

    function sendFile(m) {
      m.state = 'sending';
      render();
      const sentContact = pendingContact();
      const query = new URLSearchParams({
        v: visitor, name: m.file.name, page: location.pathname, lang: currentLang(), contact: sentContact,
      });
      fetch(`${CHAT}/upload?${query}`, { method: 'POST', headers: { 'Content-Type': m.blob.type || 'application/octet-stream' }, body: m.blob })
        .then(r => r.json().then(data => ({ ok: r.ok, status: r.status, data })))
        .then(({ ok, status, data }) => {
          if (!ok) {
            m.state = 'failed';
            if (status === 429) showToast(ct('limit'));
            return render();
          }
          m.state = '';
          m.id = data.id;
          m.t = data.t;
          m.file = Object.assign(data.file, { local: m.file.local });
          m.blob = null;
          lastId = Math.max(lastId, data.id);
          sentWith(sentContact);
          render();
        })
        .catch(() => { m.state = 'failed'; render(); });
    }

    function attach(files) {
      Array.from(files || []).forEach(blob => {
        if (blob.size > 10 * 1048576) return showToast(ct('tooLarge'));
        if (!visitor) visitor = newId();
        const image = /^image\/(png|jpeg|gif|webp)$/.test(blob.type);
        const m = {
          id: 0, owner: false, text: '', t: Math.floor(Date.now() / 1000), state: 'sending', blob,
          file: { id: '', name: blob.name || 'screenshot.png', size: blob.size, image, local: image ? URL.createObjectURL(blob) : '' },
        };
        messages.push(m);
        sendFile(m);
      });
    }

    function submit() {
      const input = $('.chat-input', panel);
      const text = input.value.trim();
      if (!text) return;
      if (!visitor) visitor = newId();
      const m = { id: 0, owner: false, text: text.slice(0, 2000), t: Math.floor(Date.now() / 1000), state: 'sending' };
      messages.push(m);
      input.value = '';
      grow(input);
      sendMessage(m);
      input.focus();
    }

    function grow(input) {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 132) + 'px';
    }

    function build() {
      panel = document.createElement('section');
      panel.className = 'chat';
      panel.hidden = true;
      panel.setAttribute('role', 'dialog');
      panel.innerHTML = `<header class="chat-head">
          <button type="button" class="chat-close" data-chat-close><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
          <span class="chat-avatar" aria-hidden="true">S</span>
          <span class="chat-who"><b class="chat-title"></b><span class="chat-sub"></span></span>
          <button type="button" class="chat-bell chat-head-btn" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg></button>
          <button type="button" class="chat-contact-toggle chat-head-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg></button>
        </header>
        <div class="chat-contact-bar" hidden>
          <input class="chat-contact" type="email" inputmode="email" maxlength="120" autocomplete="email" enterkeyhint="done">
          <button type="button" class="chat-contact-save"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5 10 17l9-10"/></svg></button>
          <button type="button" class="chat-contact-close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M17 7 7 17M7 7l10 10"/></svg></button>
        </div>
        <div class="chat-list" aria-live="polite"></div>
        <form class="chat-form">
          <input class="chat-hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
          <div class="chat-row">
            <button type="button" class="chat-attach"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg></button>
            <input class="chat-file-input" type="file" multiple hidden>
            <textarea class="chat-input" rows="1" maxlength="2000"></textarea>
            <button type="submit" class="chat-send"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3.4 20.4 21 12 3.4 3.6 3.4 10.2 15 12 3.4 13.8Z"/></svg></button>
          </div>
        </form>`;
      document.body.append(panel);
      const input = $('.chat-input', panel);
      $('.chat-close', panel).addEventListener('click', close);
      $('.chat-form', panel).addEventListener('submit', event => { event.preventDefault(); submit(); });
      input.addEventListener('input', () => grow(input));
      input.addEventListener('keydown', event => {
        // Enter sends on a keyboard; on phones Enter is a new line and the button sends
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !matchMedia('(pointer: coarse)').matches) {
          event.preventDefault();
          submit();
        }
      });
      panel.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
      const contactField = $('.chat-contact', panel);
      $('.chat-contact-toggle', panel).addEventListener('click', () => setContact(!contactShown(), true));
      const bell = $('.chat-bell', panel);
      bell.addEventListener('click', () => {
        if (bell.classList.contains('is-set')) showToast(ct('pushOnHint'));
        else enablePush(bell);
      });
      $('.chat-contact-save', panel).addEventListener('click', saveContact);
      $('.chat-contact-close', panel).addEventListener('click', () => setContact(false));
      contactField.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); saveContact(); }
        if (event.key === 'Escape') { event.stopPropagation(); setContact(false); }
      });
      // Files: the paper clip, a screenshot pasted with Ctrl+V, or files dropped on the window
      const picker = $('.chat-file-input', panel);
      $('.chat-attach', panel).addEventListener('click', () => picker.click());
      picker.addEventListener('change', () => { attach(picker.files); picker.value = ''; });
      input.addEventListener('paste', event => {
        const files = event.clipboardData && event.clipboardData.files;
        if (files && files.length) { event.preventDefault(); attach(files); }
      });
      panel.addEventListener('dragover', event => { event.preventDefault(); panel.classList.add('is-drop'); });
      panel.addEventListener('dragleave', event => { if (!panel.contains(event.relatedTarget)) panel.classList.remove('is-drop'); });
      panel.addEventListener('drop', event => {
        event.preventDefault();
        panel.classList.remove('is-drop');
        attach(event.dataTransfer && event.dataTransfer.files);
      });
      labels();
      languageListeners.push(() => { labels(); render(); });
    }

    function labels() {
      $('.chat-title', panel).textContent = ct('title');
      $('.chat-sub', panel).textContent = ct('sub');
      $('.chat-close', panel).setAttribute('aria-label', ct('close'));
      $('.chat-send', panel).setAttribute('aria-label', ct('send'));
      $('.chat-attach', panel).setAttribute('aria-label', ct('attach'));
      $('.chat-attach', panel).title = ct('attach');
      $('.chat-contact', panel).placeholder = ct('contact');
      $('.chat-bell', panel).setAttribute('aria-label', ct('notify'));
      $('.chat-bell', panel).title = ct('notify');
      $('.chat-contact-toggle', panel).setAttribute('aria-label', ct('contactToggle'));
      $('.chat-contact-toggle', panel).title = ct('contactToggle');
      $('.chat-contact-save', panel).setAttribute('aria-label', ct('contactSave'));
      $('.chat-contact-save', panel).title = ct('contactSave');
      $('.chat-contact-close', panel).setAttribute('aria-label', ct('contactHide'));
      $('.chat-contact-close', panel).title = ct('contactHide');
      $('.chat-input', panel).placeholder = ct('placeholder');
      panel.setAttribute('aria-label', ct('title'));
    }

    // A soft two-note chime made by the browser (no sound file). Browsers allow sound only after the visitor
    // has clicked or typed on the page, so the audio is unlocked on the first such action.
    let audio = null;
    function unlockAudio() {
      try {
        if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
        if (audio.state === 'suspended') audio.resume();
      } catch (e) {}
    }
    function chime() {
      if (!audio || audio.state !== 'running') return;
      const start = audio.currentTime + 0.02;
      [[660, 0], [990, 0.13]].forEach(([freq, delay]) => {
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, start + delay);
        gain.gain.exponentialRampToValueAtTime(0.18, start + delay + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + delay + 0.45);
        osc.connect(gain).connect(audio.destination);
        osc.start(start + delay);
        osc.stop(start + delay + 0.5);
      });
    }

    /* Unread answers while the chat is closed: a red counter on "Chat", "(n)" in the tab title, and a floating
       avatar in the corner with a counter and, for a few seconds, a preview of the answer (like Telegram).
       The footer link is far below, so the floating avatar is what the visitor actually sees. */
    let fab = null;
    let peekTimer = null;
    const unread = () => messages.filter(m => m.owner && m.id > seenId());
    const countText = n => (n > 9 ? '9+' : String(n));

    function setTitleCount(n) {
      const plain = document.title.replace(/^\(\d+\+?\) /, '');
      document.title = n ? `(${countText(n)}) ${plain}` : plain;
    }

    // One glass pill: a small round button that unfolds to the left with the preview, then folds back
    function buildFab() {
      fab = document.createElement('button');
      fab.type = 'button';
      fab.className = 'chat-fab';
      fab.hidden = true;
      fab.innerHTML = '<span class="chat-avatar" aria-hidden="true">S</span>'
        + '<span class="chat-peek"><b>somov</b><span class="chat-peek-text"></span></span><span class="chat-fab-count"></span>';
      document.body.append(fab);
      fab.addEventListener('click', open);
    }

    function hidePeek() {
      clearTimeout(peekTimer);
      if (fab) fab.classList.remove('is-peek');
    }

    function showPeek(m) {
      $('.chat-peek-text', fab).textContent = m.text || (m.file ? (m.file.image ? '📷 ' : '📎 ') + m.file.name : '');
      fab.classList.add('is-peek');
      clearTimeout(peekTimer);
      peekTimer = setTimeout(hidePeek, 8000);
    }

    function updateUnread(peek) {
      const list = unread();
      const n = panel && !panel.hidden ? 0 : list.length;
      openers.forEach(o => {
        const dot = $('.chat-dot', o);
        if (dot) dot.hidden = !n;
      });
      setTitleCount(n);
      if (n && !fab) buildFab();
      if (!fab) return;
      fab.hidden = !n;
      fab.setAttribute('aria-label', `${ct('unread')}: ${n}`);
      if (n && peek) showPeek(list[list.length - 1]);
      if (!n) hidePeek();
    }

    let notified = seenId();
    function notify(fresh) {
      const answers = fresh.filter(m => m.owner && m.id > notified);
      if (!answers.length) return;
      notified = Math.max(...answers.map(m => m.id));
      chime();
      updateUnread(true);
    }

    // While the chat is open: every 5 s. Closed or on another tab: every 20 s, and only for a day after the
    // visitor last wrote, so that answers are noticed without asking the server for nothing.
    function poll() {
      clearTimeout(pollTimer);
      const isOpen = panel && !panel.hidden;
      const waiting = visitor && Date.now() - Number(store.get('chatLastSent') || 0) < 86400000;
      if (!isOpen && !waiting) return;
      fetchNew().then(fresh => {
        if (fresh.length && isOpen && !panel.hidden) {
          render();
          // An answer is what the visitor waits for: show it even if the list was scrolled up (or squeezed by the keyboard)
          if (fresh.some(m => m.owner)) { const list = $('.chat-list', panel); list.scrollTop = list.scrollHeight; }
        }
        notify(fresh);
      }).catch(() => {});
      pollTimer = setTimeout(poll, isOpen && !document.hidden ? 5000 : 20000);
    }

    function open(event) {
      if (event) event.preventDefault();
      lastOpener = event && event.currentTarget;
      if (!panel) build();
      panel.hidden = false;
      root.classList.add('chat-open');
      render.done = false;
      render();
      fetchNew().then(render).catch(() => {});
      poll();
      fitViewport();
      // On a phone the keyboard would cover half the chat at once: it opens when the visitor taps the field
      if (!matchMedia('(pointer: coarse)').matches) setTimeout(() => $('.chat-input', panel).focus({ preventScroll: true }), 50);
    }

    /* Phones: the on-screen keyboard shrinks only the visible part of the page and the browser pushes the page up,
       so a full-screen chat lost its header. While the chat is open it is fitted to the visible area instead. */
    function fitViewport() {
      if (!panel) return;
      const vv = window.visualViewport;
      const phone = matchMedia('(max-width: 720px)').matches;
      if (!vv || !phone || panel.hidden) {
        panel.style.top = panel.style.height = panel.style.bottom = '';
        return;
      }
      const list = $('.chat-list', panel);
      const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
      panel.style.top = vv.offsetTop + 'px';
      panel.style.height = vv.height + 'px';
      panel.style.bottom = 'auto';
      if (nearBottom) list.scrollTop = list.scrollHeight;
    }
    if (window.visualViewport) {
      visualViewport.addEventListener('resize', fitViewport);
      visualViewport.addEventListener('scroll', fitViewport);
    }

    function close() {
      panel.hidden = true;
      fitViewport();
      root.classList.remove('chat-open');
      poll();   // keeps listening for an answer in the background (see poll)
      if (location.hash === '#chat') history.replaceState(null, '', location.pathname + location.search);
      if (lastOpener) lastOpener.focus({ preventScroll: true });
    }

    openers.forEach(o => o.addEventListener('click', open));
    ['pointerdown', 'keydown'].forEach(type => document.addEventListener(type, () => { if (visitor) unlockAudio(); }, { passive: true }));
    // Back to the page (from Telegram, another app or tab, after the phone slept): check for answers at once.
    // Phones pause hidden pages, so the timer alone can be minutes late there.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
    ['focus', 'pageshow', 'online'].forEach(type => window.addEventListener(type, () => { if (visitor) poll(); }));
    languageListeners.push(() => updateUnread());   // the language switch rewrites the tab title
    if (location.hash === '#chat') open();
    // A returning visitor: the counters and the preview when an answer came while they were away, then keep listening
    else if (visitor) {
      fetchNew().then(() => {
        updateUnread(true);
        notified = Math.max(notified, ...messages.filter(m => m.owner).map(m => m.id));
        pollTimer = setTimeout(poll, 20000);
      }).catch(() => {});
    }
  }
})();
