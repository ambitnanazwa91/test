/* TamaRodzina cloud sync, v2 — one-time pairing with persistent on-device key. */
(() => {
  'use strict';
  const API = 'https://tama-api.yoszhi.workers.dev/api/family';
  const bridge = window.tamaBridge;
  if (!bridge) { console.error('Brak integracji TamaRodzina'); return; }
  const $ = (id) => document.getElementById(id);
  const cloudBtn = $('cloudBtn');
  let token = '';
  let connected = false;
  let ready = false;
  let busy = false;
  let saving = false;
  let pending = false;
  let conflict = false;
  let lastSignature = null;
  let remoteCount = 0;
  let timer = null;

  const dialog = document.createElement('dialog');
  dialog.id = 'cloudDialog';
  dialog.innerHTML = `
    <div class="modal-header"><h3>☁️ Wspólne drzewo</h3><button class="close" id="cloudClose" aria-label="Zamknij">×</button></div>
    <div class="modal-body">
      <p style="font-size:13px;line-height:1.65;color:#686480;margin:4px 0 16px">
        Połącz to urządzenie z Waszą bazą Tamów. Ten sam klucz wpisz na telefonie Pauliny.
        Wpisujesz go tylko raz: aplikacja zapamiętuje go na tym urządzeniu
        i sama łączy się z chmurą po otwarciu. Klucz nie jest publikowany na GitHubie.
      </p>
      <div style="border:1px solid #e8defb;border-radius:18px;padding:16px;background:linear-gradient(120deg,#f7f0ff,#fff7fb);margin:5px 0 17px">
        <div style="font-size:12px;font-weight:800;color:#716398">☁️ Aktualnie zapisane w bazie D1</div>
        <div id="cloudRemoteCount" style="font-size:46px;font-weight:850;line-height:1.25;color:#42366a" aria-live="polite">—</div>
        <div id="cloudCountInfo" style="font-size:12px;color:#8f86a9;line-height:1.5">Otwórz Chmurę, aby sprawdzić bazę.</div>
      </div>
      <div class="field"><label for="cloudKey">Prywatny klucz dostępu</label>
        <input id="cloudKey" type="password" autocomplete="off" placeholder="Wklej TAMA_API_KEY" />
      </div>
      <p id="cloudStatus" role="status" style="font-size:12px;line-height:1.6;color:#767187;padding:12px;background:#f8f5ff;border-radius:12px"></p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:15px">
        <button type="button" class="btn primary" id="cloudConnect">🔐 Połącz</button>
        <button type="button" class="btn" id="cloudRefresh">↻ Sprawdź</button>
        <button type="button" class="btn danger" id="cloudDisconnect">Rozłącz</button>
      </div>
      <div class="section-divider" style="margin:20px 0 13px"></div>
      <div class="eyebrow" style="margin-bottom:8px">Przenoszenie danych</div>
      <p style="font-size:12px;line-height:1.6;color:#817b9b;margin:0 0 12px">
        Przed pierwszym połączeniem pobierz kopię zapasową z głównego ekranu.
        Wybierz kierunek tylko wtedy, gdy lokalne i chmurowe drzewo są różne.
      </p>
      <div style="display:flex;gap:9px;flex-wrap:wrap">
        <button type="button" class="btn" id="cloudUpload">↑ Wyślij moje Tamy do chmury</button>
        <button type="button" class="btn" id="cloudDownload">↓ Pobierz Tamy z chmury</button>
      </div>
      <p style="font-size:11px;line-height:1.5;color:#a39ab4;margin:14px 0 0">
        Po pierwszym połączeniu i uzgodnieniu danych zapis jest automatyczny.
        Klucz pozostaje w pamięci tej przeglądarki do użycia przycisku „Rozłącz” lub usunięcia
        danych witryny. Nie używaj tej opcji na cudzym telefonie.
        Edycje jednocześnie na dwóch urządzeniach nadal mogą wymagać ręcznego rozwiązania konfliktu.
      </p>
    </div>`;
  document.body.appendChild(dialog);
  $('cloudClose').onclick = () => dialog.close();
  cloudBtn.onclick = () => {
    updateStatus();
    if (!dialog.open) dialog.showModal();
    // Always query Cloudflare D1 on opening, even when the local tree differs.
    void refreshRemoteCount();
  };
  const keyField = $('cloudKey');

  // Tiny data fingerprint instead of duplicating full-size images in localStorage.
  function digest(text) {
    let a = 2166136261, b = 2654435761;
    for (let i = 0; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      a = Math.imul(a ^ ch, 16777619) >>> 0;
      b = Math.imul(b ^ ch, 2246822519) >>> 0;
    }
    return text.length + ':' + a.toString(16) + ':' + b.toString(16);
  }
  const signature = (tamas) => digest(JSON.stringify(
    [...tamas].map(t => [
      t.id, t.name, t.species || '', t.device, t.birth || '',
      t.notes || '', t.photo || '', t.createdAt, t.parents || []
    ]).sort((a,b) => a[0].localeCompare(b[0]))
  ));
  const ownSignature = () => signature(bridge.get());
  const getLastSaved = () => {
    try {
      const stored = localStorage.getItem('tama-cloud-last-signature');
      if (stored) return stored;
      const old = sessionStorage.getItem('tama-cloud-last-signature');
      return old && old.startsWith('[') ? digest(old) : old;
    } catch { return null; }
  };
  const rememberSignature = (sig) => {
    lastSignature = sig;
    try { localStorage.setItem('tama-cloud-last-signature', sig); } catch {}
  };
  const tell = (message) => { $('cloudStatus').textContent = message; };
  let remoteCountRequest = 0;
  async function refreshRemoteCount() {
    const requestId = ++remoteCountRequest;
    const countEl = $('cloudRemoteCount');
    const infoEl = $('cloudCountInfo');
    countEl.textContent = '…';
    infoEl.textContent = 'Sprawdzam aktualną liczbę w bazie Cloudflare D1…';
    // A fresh page load might still be establishing the existing pairing.
    if (!token) {
      try { token = localStorage.getItem('tama-cloud-key') || sessionStorage.getItem('tama-cloud-key') || ''; }
      catch { token = ''; }
    }
    if (!token) {
      countEl.textContent = '—';
      infoEl.textContent = 'Najpierw połącz aplikację z chmurą, aby odczytać bazę.';
      return;
    }
    try {
      const remote = await request('GET');
      if (requestId !== remoteCountRequest) return; // Ignore older responses.
      remoteCount = remote.tamas.length;
      countEl.textContent = String(remoteCount);
      infoEl.textContent = 'Odczyt bezpośrednio z bazy • ' + new Date().toLocaleTimeString('pl-PL', {
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
    } catch (error) {
      if (requestId !== remoteCountRequest) return;
      countEl.textContent = '—';
      infoEl.textContent = 'Nie udało się pobrać liczby z bazy: ' + (error?.message || 'błąd połączenia');
      console.warn('Błąd odczytu licznika Cloudflare D1:', error);
    }
  }
  function updateStatus(message) {
    const count = bridge.get().length;
    cloudBtn.textContent = connected ? (conflict ? '☁️ !' : ready ? '☁️ ✓' : '☁️ …') : '☁️ Chmura';
    cloudBtn.title = conflict ? 'Konflikt synchronizacji' : connected ? 'Połączono z chmurą' : 'Połącz z chmurą';
    $('cloudConnect').disabled = busy;
    $('cloudUpload').disabled = !connected || busy || saving;
    $('cloudDownload').disabled = !connected || busy || saving;
    $('cloudRefresh').disabled = !connected || busy || saving;
    $('cloudDisconnect').disabled = !connected || busy;
    if (message !== undefined) { tell(message); return; }
    if (!connected) tell('Jeszcze nie połączono. Lokalnie zapisanych: ' + count + ' Tamów.');
    else if (conflict) tell('⚠️ Wykryto różne zmiany na dwóch urządzeniach. Pobierz kopię danych przed wyborem, którą wersję zachować.');
    else if (!ready) tell('Lokalnie: ' + count + ' Tamów, w chmurze: ' + remoteCount + '. Wybierz, którą wersję zachować. Niczego nie nadpisano.');
    else if (saving || pending) tell('Synchronizuję zmiany… Lokalnie: ' + count + ' Tamów.');
    else tell('✅ Synchronizacja aktywna. ' + remoteCount + ' Tamów w chmurze. Zmiany zapisują się automatycznie.');
  }
  async function request(method, data) {
    const headers = { 'Authorization':'Bearer ' + token };
    if (method === 'PUT') headers['Content-Type'] = 'application/json';
    const response = await fetch(API, {
      method, headers, cache:'no-store',
      body: method === 'PUT' ? JSON.stringify({tamas:data}) : undefined
    });
    let output;
    try { output = await response.json(); }
    catch { throw new Error('Serwer zwrócił niepoprawną odpowiedź (' + response.status + ').'); }
    if (!response.ok) throw new Error(output.error || 'Błąd serwera: ' + response.status);
    if (method === 'GET' && !Array.isArray(output.tamas)) throw new Error('Brak listy Tamów w odpowiedzi API.');
    return output;
  }
  function reportFailure(error) {
    console.error('Tama cloud sync', error);
    updateStatus('⚠️ ' + (error?.message || 'Nie udało się połączyć z chmurą.'));
  }
  async function connect(silent = false) {
    if (busy) return;
    const entered = keyField.value.trim();
    const saved = (() => {
      try { return localStorage.getItem('tama-cloud-key') || sessionStorage.getItem('tama-cloud-key') || ''; }
      catch { return ''; }
    })();
    token = entered || saved;
    if (!token) { updateStatus('Wpisz klucz TAMA_API_KEY ustawiony w Cloudflare (tylko raz na urządzenie).'); return; }
    if (!/^[\x21-\x7E]+$/.test(token)) {
      token = '';
      updateStatus('⚠️ W kluczu jest niedozwolony znak (np. polska litera, emoji, spacja lub znak nowej linii). Ustaw w Cloudflare nowy TAMA_API_KEY z samych angielskich liter i cyfr, zapisz, a następnie wpisz go ponownie tutaj.');
      return;
    }
    busy = true;
    updateStatus('Sprawdzam połączenie…');
    try {
      // Wait for the local IndexedDB snapshot before comparing it with cloud data.
      await bridge.ready;
      const remote = await request('GET');
      const remoteSig = signature(remote.tamas);
      const localSig = ownSignature();
      const previousSig = getLastSaved();
      connected = true;
      conflict = false;
      remoteCount = remote.tamas.length;
      if (dialog.open) void refreshRemoteCount();
      // Store pairing only on this device, never in the public source code.
      try {
        localStorage.setItem('tama-cloud-key', token);
        sessionStorage.removeItem('tama-cloud-key');
      } catch {
        try { sessionStorage.setItem('tama-cloud-key', token); } catch {}
      }
      keyField.value = '';
      const takeCloud = localSig !== remoteSig &&
        (bridge.get().length === 0 || (previousSig && previousSig === localSig));
      const uploadLocal = localSig !== remoteSig && previousSig && previousSig === remoteSig;
      if (takeCloud) await bridge.replace(remote.tamas);
      rememberSignature(remoteSig);
      ready = ownSignature() === remoteSig || Boolean(uploadLocal);
      pending = Boolean(uploadLocal);
      updateStatus();
      if (pending) setTimeout(flush, 0);
      if (!ready && !silent && !dialog.open) dialog.showModal();
    } catch (error) {
      connected = false; ready = false; conflict = false;
      if (/Nieprawidłowy klucz/.test(error?.message || '')) {
        try { localStorage.removeItem('tama-cloud-key'); sessionStorage.removeItem('tama-cloud-key'); } catch {}
      }
      reportFailure(error);
    } finally { busy = false; updateStatus( $('cloudStatus').textContent ); }
  }
  function refreshAfterWrite() {
    const curr = ownSignature();
    pending = curr !== lastSignature;
    updateStatus();
    if (pending && ready) setTimeout(flush, 0);
  }
  async function flush() {
    if (!connected || !ready || conflict || !pending || saving || busy) return;
    saving = true;
    pending = false;
    updateStatus();
    try {
      // Verify no other phone has modified the remote tree since the previous sync.
      const remote = await request('GET');
      if (signature(remote.tamas) !== lastSignature) {
        conflict = true; ready = false; remoteCount = remote.tamas.length;
        updateStatus(); if (!dialog.open) dialog.showModal();
        return;
      }
      const payload = bridge.get();
      await request('PUT', payload);
      rememberSignature(signature(payload));
      remoteCount = payload.length;
      if (dialog.open) void refreshRemoteCount();
    } catch (error) {
      pending = true;
      reportFailure(error);
    } finally {
      saving = false;
      // If edits happened while the request was in flight, queue another write.
      if (ready && !conflict) refreshAfterWrite();
    }
  }
  async function forceUpload() {
    if (!connected || saving || busy) return;
    const local = bridge.get();
    if (!local.length && remoteCount) {
      updateStatus('Nie wysyłaj pustego drzewa do pełnej bazy. Najpierw pobierz Tamy z chmury.');
      return;
    }
    if (!confirm('Wysłać ' + local.length + ' Tamów do bazy i ZASTĄPIĆ jej obecną zawartość (' + remoteCount + ' Tamów)?\n\nJeżeli Paulina dodała nowe Tamy, mogą zostać nadpisane. Najpierw pobierz kopię zapasową.')) return;
    busy = true; updateStatus('Wysyłam Tamy do chmury…');
    try {
      await request('PUT', local);
      rememberSignature(signature(local));
      remoteCount = local.length;
      if (dialog.open) void refreshRemoteCount();
      ready = true; conflict = false;
      refreshAfterWrite();
    } catch(error) { reportFailure(error); }
    finally { busy = false; updateStatus($('cloudStatus').textContent); }
  }
  async function forceDownload() {
    if (!connected || saving || busy) return;
    if (bridge.get().length && !confirm(
      'Pobrać drzewo z chmury i ZASTĄPIĆ lokalne Tamy?\n\nNajpierw użyj przycisku Kopia na głównym ekranie, aby zachować lokalną wersję.'
    )) return;
    busy = true; updateStatus('Pobieram drzewo…');
    try {
      const remote = await request('GET');
      await bridge.replace(remote.tamas);
      rememberSignature(signature(remote.tamas));
      remoteCount = remote.tamas.length;
      if (dialog.open) void refreshRemoteCount();
      ready = true; conflict = false; pending = false;
      updateStatus();
    } catch(error) { reportFailure(error); }
    finally { busy = false; updateStatus($('cloudStatus').textContent); }
  }
  async function refresh() {
    if (!connected || saving || pending || busy || !ready) {
      if (connected && !ready) updateStatus('Najpierw wybierz, czy zachować dane lokalne, czy chmurowe.');
      return;
    }
    busy = true;
    try {
      const localSigBefore = ownSignature();
      const remote = await request('GET');
      const remoteSig = signature(remote.tamas);
      remoteCount = remote.tamas.length;
      if (remoteSig !== lastSignature) {
        if (localSigBefore === lastSignature && ownSignature() === localSigBefore) {
          await bridge.replace(remote.tamas);
          rememberSignature(remoteSig);
        } else {
          conflict = true; ready = false;
          if (!dialog.open) dialog.showModal();
        }
      }
      updateStatus();
    } catch(error) { reportFailure(error); }
    finally { busy = false; updateStatus($('cloudStatus').textContent); }
  }
  function disconnect() {
    token = ''; connected = false; ready = false; conflict = false; pending = false;
    lastSignature = null; remoteCount = 0;
    try {
      localStorage.removeItem('tama-cloud-key');
      localStorage.removeItem('tama-cloud-last-signature');
      sessionStorage.removeItem('tama-cloud-key');
      sessionStorage.removeItem('tama-cloud-last-signature');
    } catch {}
    keyField.value = '';
    ++remoteCountRequest;
    $('cloudRemoteCount').textContent = '—';
    $('cloudCountInfo').textContent = 'Rozłączono — połącz się, aby ponownie odczytać liczbę z bazy.';
    updateStatus('Rozłączono. Twoje lokalne Tamy pozostały bez zmian.');
  }
  $('cloudConnect').onclick = () => connect(false);
  $('cloudUpload').onclick = forceUpload;
  $('cloudDownload').onclick = forceDownload;
  $('cloudRefresh').onclick = refresh;
  $('cloudDisconnect').onclick = disconnect;
  window.tamaCloudIsConnected = () => connected;
  window.addEventListener('tama:local-change', () => {
    if (!connected) return;
    if (!ready) { updateStatus(); return; }
    pending = true; updateStatus();
    clearTimeout(timer);
    timer = setTimeout(flush, 700);
  });
  // Refresh from the other phone while the app is open and connected.
  setInterval(() => {
    if (document.hidden) return;
    if (connected && pending && ready && !saving && !busy) flush();
    else if (connected) refresh();
    else if (storedKeyPresent()) connect(true);
  }, 20000);
  const storedKeyPresent = () => {
    try { return Boolean(localStorage.getItem('tama-cloud-key') || sessionStorage.getItem('tama-cloud-key')); }
    catch { return false; }
  };
  window.addEventListener('focus', () => {
    if (connected && pending) flush();
    else if (connected) refresh();
    else if (storedKeyPresent()) connect(true);
  });
  window.addEventListener('online', () => {
    if (connected && pending) flush();
    else if (!connected && storedKeyPresent()) connect(true);
  });
  updateStatus();
  if (storedKeyPresent()) connect(true);
})();