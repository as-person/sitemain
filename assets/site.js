(function () {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const root = document.documentElement;

  const STRINGS = {
    en: { copied: 'Copied', copyFailed: 'Could not copy', found: 'Found', clicks: 'Downloads', download: 'Download', linkCopied: 'Link copied' },
    ru: { copied: 'Скопировано', copyFailed: 'Не удалось скопировать', found: 'Найдено', clicks: 'Скачиваний', download: 'Скачать', linkCopied: 'Ссылка скопирована' },
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
    const link = event.target.closest && event.target.closest('[data-count-file]');
    if (!link) return;
    const url = COUNTER + '/count?file=' + encodeURIComponent(link.dataset.countFile) + '&kind=' + link.dataset.countKind;
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
  }
  if ($('[data-stats-file]')) {
    languageListeners.push(renderStats);
    fetch(COUNTER + '/stats')
      .then(response => response.json())
      .then(data => {
        if (data.owner) {
          statsCounts = data.counts;
          renderStats();
        }
      })
      .catch(() => {});
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

  /* Telegram card: report clicks to Analytics with the place they came from */
  $$('[data-tg-placement]').forEach(link => link.addEventListener('click', () => {
    if (typeof window.gtag === 'function') {
      window.gtag('event', 'telegram_click', { placement: link.dataset.tgPlacement, transport_type: 'beacon' });
    }
  }));

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

    function show(index) {
      current = (index + shots.length) % shots.length;
      image.src = shots[current].href;
      image.alt = $('img', shots[current]).alt;
      counter.textContent = (current + 1) + ' / ' + shots.length;
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

    // Touch: swipe left or right to browse, up or down to close. The image follows the finger.
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const EASE = '220ms cubic-bezier(.2, 0, 0, 1)';
    let drag = null;
    let suppressClick = false;

    function setDrag(x, y, fade) {
      image.style.translate = x + 'px ' + y + 'px';
      lightbox.style.backgroundColor = fade === undefined ? '' : 'rgb(8 9 12 / ' + (0.94 * fade).toFixed(3) + ')';
    }
    function animate(apply, done) {
      const ms = reduceMotion.matches ? 0 : 220;
      image.style.transition = ms ? 'translate ' + EASE + ', opacity ' + EASE : 'none';
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
    lightbox.addEventListener('close', resetDrag);

    lightbox.addEventListener('pointerdown', event => {
      if (event.pointerType === 'mouse' || !event.isPrimary || event.target.closest('.lb-btn')) return;
      // Leave the gesture to the browser while the page is pinch-zoomed in.
      if (window.visualViewport && window.visualViewport.scale > 1.01) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, dy: 0, axis: null, t: event.timeStamp };
      image.style.transition = lightbox.style.transition = 'none';
    });
    lightbox.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      drag.dx = event.clientX - drag.x;
      drag.dy = event.clientY - drag.y;
      if (!drag.axis && Math.hypot(drag.dx, drag.dy) > 10) {
        drag.axis = Math.abs(drag.dx) > Math.abs(drag.dy) ? 'x' : 'y';
      }
      if (drag.axis === 'x') setDrag(drag.dx, 0);
      if (drag.axis === 'y') setDrag(0, drag.dy, Math.max(0.3, 1 - Math.abs(drag.dy) / 400));
    });
    function endDrag(event) {
      if (!drag || event.pointerId !== drag.id) return;
      const { axis, dx, dy, t } = drag;
      drag = null;
      if (!axis) return resetDrag();
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
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
    lightbox.addEventListener('pointerup', endDrag);
    lightbox.addEventListener('pointercancel', endDrag);
    // A swipe must not count as a tap on the backdrop.
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
