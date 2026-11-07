(function () {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const root = document.documentElement;

  const STRINGS = {
    en: { copied: 'Copied', copyFailed: 'Could not copy', found: 'Found', clicks: 'Downloads', download: 'Download' },
    ru: { copied: 'Скопировано', copyFailed: 'Не удалось скопировать', found: 'Найдено', clicks: 'Скачиваний', download: 'Скачать' },
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
    imageSwitches.forEach(link => link.addEventListener('click', event => {
      event.preventDefault();
      root.dataset.image = link.dataset.switchImage;
      history.replaceState(null, '', link.getAttribute('href'));
      syncImageSwitches();
    }));
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
