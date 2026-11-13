/* Site chat. site.js loads this file only when it is needed (see "Chat with the author" there):
   most visitors never open the chat, so they do not download it. */
(function () {
  'use strict';

  const { $, $$, root, currentLang, languageListeners, showToast, t } = window.siteChat;

  /* Chat with the author: messages go to dl.somov.org (_src/chat/server.py), a Telegram bot brings them to the
     owner, and his Telegram replies come back here. A visitor is a random id kept in this browser. */
  const CHAT = 'https://dl.somov.org/api/chat';
  const CHAT_TEXT = {
    en: { title: 'somov', sub: 'ask a question', contact: 'Your email for a reply', placeholder: 'Message', send: 'Send', close: 'Close', today: 'Today', yesterday: 'Yesterday', failed: 'Not sent. Tap to retry', limit: 'Too many messages. Try again a bit later.', attach: 'Attach a photo or file', tooLarge: 'The file is larger than 10 MB', kb: 'KB', mb: 'MB', notify: 'Let me know when the answer comes', notifyHint: 'A notification will come even if the site is closed', pushOn: 'Notifications are on', pushDenied: 'Notifications are blocked in the browser settings', pushFailed: 'Could not turn notifications on', contactToggle: 'Email for a reply', contactSave: 'Save', contactHide: 'Hide', contactSaved: 'Letter sent — confirm your email', contactRemoved: 'Contact removed', contactLater: 'The contact will go with your first message', contactFailed: 'Could not save the contact', pushOnHint: 'Notifications are on. They can be turned off in the browser settings', unread: 'New answers', introHead: 'Ask a question and we will answer here.', introText: 'If you close the site, the answer is easy to miss. Leave your email and *confirm it* from the letter — we will send the answer there too.', introButton: 'Leave your email', contactBad: 'This does not look like an email', verifyTitle: 'Confirm your email', verifyWhere: 'The link is in the letter to {email}.', verifyElse: '*Until you confirm it*, the answer comes only here.', introVerified: 'Your email {email} is confirmed. Now *write your question* — the answer comes here and to your email.', introSaved: 'Your email {email} is saved. Now *write your question* — the answer comes here, and once the email is confirmed, there too.', introChange: 'Change the email' },
    ru: { title: 'somov', sub: 'задайте вопрос', contact: 'Ваша почта для ответа', placeholder: 'Сообщение', send: 'Отправить', close: 'Закрыть', today: 'Сегодня', yesterday: 'Вчера', failed: 'Не отправлено. Нажмите, чтобы повторить', limit: 'Слишком много сообщений. Попробуйте чуть позже.', attach: 'Прикрепить фото или файл', tooLarge: 'Файл больше 10 МБ', kb: 'КБ', mb: 'МБ', notify: 'Сообщить, когда придёт ответ', notifyHint: 'Уведомление придёт, даже если сайт будет закрыт', pushOn: 'Уведомления включены', pushDenied: 'Уведомления запрещены в настройках браузера', pushFailed: 'Не удалось включить уведомления', contactToggle: 'Почта для ответа', contactSave: 'Сохранить', contactHide: 'Скрыть', contactSaved: 'Письмо отправлено — подтвердите почту', contactRemoved: 'Контакт удалён', contactLater: 'Контакт уйдёт вместе с первым сообщением', contactFailed: 'Не удалось сохранить контакт', pushOnHint: 'Уведомления включены. Выключить их можно в настройках браузера', unread: 'Новые ответы', introHead: 'Напишите вопрос — мы ответим здесь.', introText: 'Если закроете сайт, ответ легко пропустить. Оставьте почту и *подтвердите её* по ссылке из письма — продублируем ответ туда.', introButton: 'Оставить почту', contactBad: 'Это не похоже на адрес почты', verifyTitle: 'Подтвердите почту', verifyWhere: 'Ссылка — в письме на {email}.', verifyElse: '*Без подтверждения* ответ придёт только сюда.', introVerified: 'Почта {email} подтверждена. Теперь *напишите вопрос* — ответ придёт сюда и на почту.', introSaved: 'Почта {email} сохранена. Теперь *напишите вопрос* — ответ придёт сюда, а после подтверждения почты и туда.', introChange: 'Изменить почту' },
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
      if (!hasContact && !savedContact()) list.append(introNode());
      // An email saved before the first message: say it is kept and ask for the question
      else if (!hasThread() && savedContact()) list.append(introNode(savedContact()));
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
      verifyUi();
      if (nearBottom || !render.done) list.scrollTop = list.scrollHeight;
      render.done = true;
      const ownerIds = messages.filter(m => m.owner).map(m => m.id);
      if (ownerIds.length) store.set('chatSeen', String(Math.max(seenId(), ...ownerIds)));
      updateUnread();
    }

    // Text with *marked* words shown in the accent colour (what the visitor has to do: confirm the email).
    // Built from text nodes, never as HTML: the email in it is typed by the visitor.
    function accented(element, text) {
      element.textContent = '';
      text.split(/\*([^*]+)\*/).forEach((part, i) => {
        if (!part) return;
        if (i % 2) {
          const mark = document.createElement('strong');
          mark.className = 'chat-accent';
          mark.textContent = part;
          element.append(mark);
        } else {
          element.append(part);
        }
      });
    }

    function introNode(saved) {
      const intro = document.createElement('div');
      intro.className = 'chat-intro';
      const head = document.createElement('b');
      head.textContent = ct('introHead');
      const text = document.createElement('span');
      accented(text, saved ? '✉️ ' + ct(hasContact && verified ? 'introVerified' : 'introSaved').replace('{email}', saved) : ct('introText'));
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = saved ? ct('introChange') : '✉️ ' + ct('introButton');
      button.addEventListener('click', () => setContact(true, true));
      intro.append(head, text);
      if (!contactShown()) intro.append(button);   // the bar is folded: the button brings it back (to change it)
      return intro;
    }

    // The email waits for confirmation: a pinned blue bar under the header, the one coloured spot in the window
    function verifyUi() {
      const bar = $('.chat-verify-bar', panel);
      const show = hasContact && !verified;
      if (show) {
        $('.chat-verify-title', bar).textContent = ct('verifyTitle');
        const address = savedContact();
        accented($('.chat-verify-sub', bar), (address ? ct('verifyWhere').replace('{email}', address) + ' ' : '') + ct('verifyElse'));
        if (bar.hidden) pulse(bar);
      }
      bar.hidden = !show;
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
      // The email goes to the server at once (even before the first message): the confirmation letter comes right away
      if (!visitor) visitor = newId();
      fetch(`${CHAT}/contact?v=${visitor}`, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify({ contact: value, lang: currentLang() }) })
        .then(r => {
          if (!r.ok) throw new Error('contact');
          store.set('chatVisitor', visitor);
          hasContact = !!value;
          if (value) verified = false;
          setContact(false);
          verifyUi();
          showToast(ct(value ? 'contactSaved' : 'contactRemoved'));
          fetchNew().then(() => { verifyUi(); render(); }).catch(() => {});
        })
        .catch(() => {
          if (hasThread()) return showToast(ct('contactFailed'));
          setContact(false);   // not reached now: it goes with the first message
          if (value) showToast(ct('contactLater'));
        });
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
        <div class="chat-verify-bar" role="status" hidden><span class="chat-verify-icon" aria-hidden="true">📩</span><span class="chat-verify-text"><b class="chat-verify-title"></b><span class="chat-verify-sub"></span></span></div>
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
      const wasVerified = verified;
      fetchNew().then(fresh => {
        // The confirmation is not a message: refresh the bar (and the intro that names the email) on every check
        if (isOpen && !panel.hidden) { if (verified !== wasVerified && !fresh.length) render(); else verifyUi(); }
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
      clearTimeout(closeTimer);   // opened again while it was closing: stay open
      panel.classList.remove('is-closing');
      panel.hidden = false;
      root.classList.add('chat-open');
      render.done = false;
      render();
      fetchNew().then(render).catch(() => {});
      poll();
      fitViewport();
      // The open chat is a step in the browser history (same address): "Back" (a swipe, the phone's button,
      // the browser's arrow) closes the chat instead of leaving the page
      if (!(history.state && history.state.chat)) history.pushState({ chat: true }, '', location.href.replace(/#chat$/, ''));
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

    // The cross and Esc go "back" too, so the chat's history step does not stay behind; "Back" itself lands in
    // the popstate listener below. Both end in closeNow().
    function close() {
      if (history.state && history.state.chat) history.back();
      else closeNow();
    }
    window.addEventListener('popstate', () => {
      if (panel && !panel.hidden && !(history.state && history.state.chat)) closeNow();
    });

    // Closing plays the way back (`is-closing` in site.css) and only then hides the window
    let closeTimer = null;
    function closeNow() {
      if (panel.hidden || panel.classList.contains('is-closing')) return;
      const finish = () => {
        clearTimeout(closeTimer);
        if (!panel.classList.contains('is-closing')) return;   // reopened meanwhile
        panel.classList.remove('is-closing');
        panel.hidden = true;
        fitViewport();
        root.classList.remove('chat-open');
        poll();   // keeps listening for an answer in the background (see poll)
      };
      panel.classList.add('is-closing');
      const animated = getComputedStyle(panel).animationName !== 'none';
      if (animated) {
        panel.addEventListener('animationend', finish, { once: true });
        closeTimer = setTimeout(finish, 400);   // in case the animation event never comes
      } else {
        finish();
      }
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
    window.siteChat.open = open;   // site.js calls it after loading this file on the first press of a Chat link
  }
})();
