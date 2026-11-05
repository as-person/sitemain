(function () {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const root = document.documentElement;

  const STRINGS = {
    en: { copied: 'Copied', copyFailed: 'Could not copy', found: 'Found' },
    ru: { copied: 'Скопировано', copyFailed: 'Не удалось скопировать', found: 'Найдено' },
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

  /* Home: build picker. The selection is mirrored in the URL so it can be shared. */
  const buildsData = $('#builds-data');
  if (buildsData) {
    const builds = JSON.parse(buildsData.textContent);
    const osInputs = $$('input[name="os"]');
    const langInputs = $$('input[name="image-lang"]');
    const selected = inputs => inputs.find(input => input.checked).value;
    const select = (inputs, value) => {
      const match = inputs.find(input => input.value === value);
      if (match) match.checked = true;
    };
    const urlHasSelection = () => new URLSearchParams(location.search).has('os');

    function render(updateUrl) {
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
      if (updateUrl) {
        const url = new URL(location.href);
        url.searchParams.set('os', os);
        url.searchParams.set('lang', imageLang);
        history.replaceState(null, '', url);
      }
    }

    // The image language follows the site language unless the link says otherwise.
    const params = new URLSearchParams(location.search);
    select(langInputs, currentLang());
    select(osInputs, params.get('os'));
    select(langInputs, params.get('lang'));
    render(false);
    osInputs.concat(langInputs).forEach(input => input.addEventListener('change', () => render(true)));
    languageListeners.push(lang => {
      select(langInputs, lang);
      render(urlHasSelection());
    });
  }

  /* Build page: screenshot lightbox on a native dialog */
  const lightbox = $('#lightbox');
  if (lightbox && lightbox.showModal) {
    const shots = $$('.shot');
    const image = $('img', lightbox);
    const counter = $('.lb-count', lightbox);
    let current = 0;

    function show(index) {
      current = (index + shots.length) % shots.length;
      image.src = shots[current].href;
      image.alt = $('img', shots[current]).alt;
      counter.textContent = (current + 1) + ' / ' + shots.length;
    }

    shots.forEach((shot, index) => shot.addEventListener('click', event => {
      event.preventDefault();
      show(index);
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
