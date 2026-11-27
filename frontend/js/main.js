let apiPrefix = "https://vs7ubni3p3.execute-api.eu-central-1.amazonaws.com/";

// Aktuelle Ansicht: 'today', 'work', 'all' oder 'account'
let currentView = 'today';

const TASK_ACTIONS = {
    'done':      { method: 'PATCH',  path: id => `user/${$.cookie('user_id')}/task/${id}/done` },
    'not-today': { method: 'PATCH',  path: id => `user/${$.cookie('user_id')}/task/${id}/today` },
    'to-today':  { method: 'PATCH',  path: id => `user/${$.cookie('user_id')}/task/${id}/today` },
    'tomorrow':  { method: 'PATCH',  path: id => `user/${$.cookie('user_id')}/task/${id}/tomorrow` },
    'next-week': { method: 'PATCH',  path: id => `user/${$.cookie('user_id')}/task/${id}/next-week` },
    'delete':    { method: 'DELETE', path: id => `user/${$.cookie('user_id')}/task/${id}` },
};

// ---------- Login über Cognito ----------

const COGNITO_URL = 'https://cognito-idp.eu-central-1.amazonaws.com/';
const COGNITO_CLIENT_ID = 'p38f8tnjpppdfpmppstuu2jqt';
const LOGIN_PAGE = './login.html';
const HOME_PAGE = './';
const TOKEN_KEYS = ['quarto_id_token', 'quarto_token_exp', 'quarto_refresh_token'];

function cognitoCall(target, body) {
    return $.ajax({
        url: COGNITO_URL,
        method: 'POST',
        headers: { 'X-Amz-Target': 'AWSCognitoIdentityProviderService.' + target },
        contentType: 'application/x-amz-json-1.1',
        data: JSON.stringify(body),
        dataType: 'json',
    });
}

function saveTokens(result) {
    localStorage.setItem('quarto_id_token', result.IdToken);
    localStorage.setItem('quarto_token_exp', String(Date.now() + result.ExpiresIn * 1000));
    if (result.RefreshToken) {
        localStorage.setItem('quarto_refresh_token', result.RefreshToken);
    }
}

function tokenExpiresSoon() {
    return Number(localStorage.getItem('quarto_token_exp') || 0) - Date.now() < 5 * 60 * 1000;
}

let refreshing = null;
function refreshTokens() {
    if (refreshing) return refreshing;
    const refreshToken = localStorage.getItem('quarto_refresh_token');
    if (!refreshToken) {
        logout();
        return Promise.reject();
    }
    refreshing = Promise.resolve(cognitoCall('InitiateAuth', {
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: COGNITO_CLIENT_ID,
        AuthParameters: { REFRESH_TOKEN: refreshToken },
    }))
        .then(resp => saveTokens(resp.AuthenticationResult))
        .catch(err => {
            // 400 = Refresh-Token ungültig oder abgelaufen, sonst eher Netzproblem
            if (err && err.status === 400) logout();
            throw err;
        })
        .finally(() => { refreshing = null; });
    return refreshing;
}

// Token an jeden Aufruf der eigenen API hängen, nicht an Cognito selbst
$.ajaxSetup({
    beforeSend: function (xhr, settings) {
        const token = localStorage.getItem('quarto_id_token');
        if (token && settings.url.startsWith(apiPrefix)) {
            xhr.setRequestHeader('Authorization', 'Bearer ' + token);
        }
    }
});

// Bei 401 einmal Token erneuern und neu laden, höchstens einmal pro Minute
let lastAuthRetry = 0;
$(document).ajaxError(function (event, xhr, settings) {
    if (xhr.status === 401 && settings.url.startsWith(apiPrefix) && Date.now() - lastAuthRetry > 60000) {
        lastAuthRetry = Date.now();
        refreshTokens().then(() => reloadCurrentView()).catch(() => {});
    }
});

function isAppPage() {
    return !!document.getElementById('task-list');
}

// App kommt aus dem Hintergrund zurück
document.addEventListener('visibilitychange', function () {
    if (isAppPage() && !document.hidden && localStorage.getItem('quarto_refresh_token') && tokenExpiresSoon()) {
        refreshTokens().then(() => reloadCurrentView()).catch(() => {});
    }
});

function checkAuth() {
    if (!localStorage.getItem('quarto_refresh_token') || typeof $.cookie('user_id') == 'undefined') {
        window.location.href = LOGIN_PAGE;
        return;
    }
    if (tokenExpiresSoon()) {
        refreshTokens().then(() => reloadCurrentView()).catch(() => {});
    }
}

function login() {
    const name = $('#loginName').val().trim();
    const password = $('#loginPassword').val();
    $('#loginError').text('');
    cognitoCall('InitiateAuth', {
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: COGNITO_CLIENT_ID,
        AuthParameters: { USERNAME: name, PASSWORD: password },
    })
        .then(function (resp) {
            saveTokens(resp.AuthenticationResult);
            return $.ajax({
                url: apiPrefix + 'user?user_name=' + encodeURIComponent(name),
                method: 'GET',
                dataType: 'json',
            });
        })
        .then(function (user) {
            $.cookie('user_id', user.id, { expires: 365 });
            window.location.href = HOME_PAGE;
        })
        .catch(function () {
            $('#loginError').text('Login fehlgeschlagen. Name oder Passwort falsch?');
        });
}

function logout() {
    $.removeCookie('user_id');
    TOKEN_KEYS.forEach(k => localStorage.removeItem(k));
    window.location.href = LOGIN_PAGE;
}

// ---------- Kontext Privat/Arbeit ----------

let allKontext = localStorage.getItem('quarto_all_kontext') || 'privat';

function isDayView(view) {
    return view === 'today' || view === 'work';
}

function kontextFor(view) {
    if (view === 'work') return 'arbeit';
    if (view === 'all') return allKontext;
    if (view === 'long') return currentView === 'work' ? 'arbeit' : 'privat';
    return 'privat';
}

function setAllKontext(kontext) {
    commitPending();
    allKontext = kontext;
    try { localStorage.setItem('quarto_all_kontext', kontext); } catch (e) {}
    reloadCurrentView();
}

// ---------- Ansichten ----------

const VIEWS = {
    today:   { title: 'Heute',  hash: '#heute' },
    work:    { title: 'Arbeit', hash: '#arbeit' },
    all:     { title: 'Alle',   hash: '#alle' },
    account: { title: 'Konto',  hash: '#konto' },
};

function setView(view) {
    commitPending();
    currentView = view;
    $('[data-view]').removeClass('active');
    $(`[data-view="${view}"]`).addClass('active');
    $('#view-title').text(VIEWS[view].title);
    $('#view-date').text(new Date().toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' }));
    $('body').attr('data-current', view);
    closeMenu();
    // Ansicht in der URL merken, damit ein Reload auf derselben Seite bleibt
    history.replaceState(null, '', VIEWS[view].hash);
    reloadCurrentView();
}

function reloadCurrentView() {
    if (!isAppPage()) return;
    loadView(currentView);
}

// ---------- Cache (Optimistic UI) ----------

function cacheKey(view) {
    return `quarto_${view}_${kontextFor(view)}_${$.cookie('user_id')}`;
}

function readCache(view) {
    try { return JSON.parse(localStorage.getItem(cacheKey(view))); } catch (e) { return null; }
}

function writeCache(view, items) {
    try { localStorage.setItem(cacheKey(view), JSON.stringify(items)); } catch (e) {}
    updateCounts();
}

function readRaw(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
}

// Zeigt sofort den Cache und lädt im Hintergrund den aktuellen Stand
function loadView(view) {
    const isAccount = view === 'account';
    renderVacation();
    $('#account-section').prop('hidden', !isAccount);
    $('#lists').prop('hidden', isAccount);
    $('#budget').prop('hidden', view !== 'today');
    $('#kontext-toggle').prop('hidden', view !== 'all');
    if (isAccount) {
        loadAccount();
        return;
    }

    $('#addTaskButton').prop('hidden', view !== 'all');
    $('#evergreen-section').prop('hidden', !(view === 'all' && allKontext === 'privat'));
    $('#evergreen-chips').prop('hidden', view !== 'today');
    $('#long-section').prop('hidden', !isDayView(view));
    $('#kontext-toggle button').each(function () {
        $(this).toggleClass('active', this.getAttribute('data-kontext') === allKontext);
    });
    $('#longInput').attr('placeholder', view === 'work' ? 'Einmalig: Diagramm bis fr' : 'Einmalig: Steuer bis 31.7.');

    const cached = readCache(view);
    if (cached) {
        renderTable(cached, view);
    }

    const path = view === 'all' ? '/tasks' : '/tasks/today';
    $.ajax({
        url: apiPrefix + 'user/' + $.cookie('user_id') + path + '?kontext=' + kontextFor(view),
        method: 'GET',
        dataType: 'json',
        success: function (response) {
            const changed = JSON.stringify(response) !== JSON.stringify(cached);
            writeCache(view, response);
            if (view === 'all' && allKontext === 'privat') {
                writeCache('evergreen', response.filter(t => t.evergreen));
            }
            if (currentView === view && changed) {
                renderTable(response, view);
            }
        },
        error: function (xhr, status, error) {
            console.error('Error fetching data:', status, error);
        }
    });
    if (isDayView(view)) {
        loadLong();
    }
    if (view === 'today') {
        loadBudget();
        loadEvergreens();
    }
}

function renderTable(items, view) {
    const $list = $('#task-list');
    $list.empty();
    $list.toggleClass('all-view', view === 'all');

    if (isDayView(view)) items = items.filter(t => !isPending(t.id));
    if (view === 'all') {
        if (allKontext === 'privat') renderEvergreens(items.filter(t => t.evergreen));
        items = items.filter(t => !t.evergreen);
    }
    if (items.length === 0) {
        $list.append(`<div class="empty">${view === 'all' ? 'Keine Aufgaben' : 'Alles erledigt'}</div>`);
    } else {
        items.forEach(item => $list.append(buildRow(item, view)));
    }
    initSortable(view);
    if (view === 'today') {
        renderBudget();
        renderChips();
    }
}

// ---------- Zeilen ----------

function buildRow(item, view, long = false) {
    const subs = item.subtasks || [];
    const done = subs.filter(s => s.done).length;
    const hasDetail = subs.length > 0 || !!item.notiz;
    const open = hasDetail && openTasks.has(String(item.id));
    const isWork = (long ? kontextFor('long') : kontextFor(view)) === 'arbeit';

    const badges = (subs.length ? `<span class="mono muted sub-count">${done}/${subs.length}</span>` : '')
        + (item.notiz ? '<i class="bi bi-journal-text muted"></i>' : '');

    // Rechte Spalte: Deadline, Fälligkeit, Dauer
    let meta = '';
    if (item.deadline) {
        const days = daysUntil(item.deadline);
        meta += `<span class="chip${days <= 2 ? ' hot' : ''}">${shortDays(days)}</span>`;
    } else if (view === 'all' && item.dueDate) {
        const days = daysUntil(item.dueDate);
        meta += `<span class="mono${days < 0 ? ' overdue' : ' muted'}">${shortDays(days)}</span>`;
    } else if (!long && item.dueDate && daysUntil(item.dueDate) < 0) {
        meta += `<span class="mono overdue">${daysUntil(item.dueDate)}d</span>`;
    }
    if (view === 'all' && item.rhythm) {
        meta += `<span class="mono muted rhythm">${escapeHtml(item.rhythm)}</span>`;
    }
    if (!long && !isWork && item.duration) {
        meta += `<span class="mono muted">${item.duration}m</span>`;
    }
    if (view === 'all' && !isWork && item.priorityLevel && item.priorityLevel.name) {
        meta += `<span class="prio prio-${item.priorityLevel.name.toLowerCase()}" title="${item.priorityLevel.name}"></span>`;
    }

    let detail = '';
    if (open) {
        const pct = subs.length ? Math.round(100 * done / subs.length) : 0;
        detail = '<div class="detail">'
            + (subs.length ? `<div class="sub-progress"><span style="width:${pct}%"></span></div>` : '')
            + subs.map(s =>
                `<button type="button" class="subtask${s.done ? ' done' : ''}" data-task="${item.id}" data-sub="${s.id}">`
                + `<span class="box">${s.done ? '<i class="bi bi-check"></i>' : ''}</span>`
                + `<span class="sub-name">${escapeHtml(s.name)}</span></button>`).join('')
            + (item.notiz ? `<div class="note">${linkify(escapeHtml(item.notiz))}</div>` : '')
            + '</div>';
    }

    const classes = ['row'];
    if (long) classes.push('long-row');
    if (open) classes.push('open');
    if (hasDetail) classes.push('has-detail');

    return `
        <div class="${classes.join(' ')}" data-id="${item.id}" data-name="${escapeHtml(item.name)}" data-long="${item.longTerm ? 'true' : 'false'}">
            <span class="grip"><i class="bi bi-grip-vertical"></i></span>
            <button type="button" class="check${item.spontan ? ' spontan' : ''}" aria-label="Erledigt"><i class="bi bi-check"></i></button>
            <div class="row-main">
                <div class="row-line">
                    <span class="name">${escapeHtml(item.name)}</span>
                    ${badges}
                </div>
                ${detail}
            </div>
            <div class="meta">${meta}</div>
            <button type="button" class="more" aria-label="Mehr"><i class="bi bi-three-dots"></i></button>
        </div>
    `;
}

// Menüeinträge je nach Liste
function menuItems(id, isLong, isEvergreen) {
    if (isEvergreen) {
        return [
            ['ev-today', 'Heute', 'bi-sun'],
            ['ev-rename', 'Umbenennen', 'bi-pencil'],
            ['delete', 'Löschen', 'bi-trash'],
        ];
    }
    if (isLong) {
        return [
            ['to-today', 'Heute', 'bi-sun'],
            ['details', 'Details', 'bi-journal-text'],
            ['delete', 'Löschen', 'bi-trash'],
        ];
    }
    if (isDayView(currentView)) {
        return [
            ['not-today', 'Nicht heute', 'bi-x-lg'],
            ['tomorrow', 'Morgen', 'bi-arrow-right'],
            ['next-week', 'Nächste Woche', 'bi-calendar-week'],
            ['details', 'Details', 'bi-journal-text'],
        ];
    }
    return [
        ['edit', 'Bearbeiten', 'bi-pencil'],
        ['tomorrow', 'Morgen', 'bi-arrow-right'],
        ['next-week', 'Nächste Woche', 'bi-calendar-week'],
        ['delete', 'Löschen', 'bi-trash'],
    ];
}

// ---------- Menü ----------

function openMenu(button) {
    const $row = $(button).closest('.row');
    const id = $row.attr('data-id');
    const isLong = $row.hasClass('long-row');
    const $menu = $('#row-menu');
    if (!$menu.prop('hidden') && $menu.attr('data-for') === id) {
        closeMenu();
        return;
    }
    $menu.attr('data-for', id).html(menuItems(id, isLong, $row.hasClass('ev-row')).map(([action, label, icon]) =>
        `<button type="button" data-action="${action}" class="${action === 'delete' ? 'danger' : ''}"><i class="bi ${icon}"></i>${label}</button>`
    ).join('')).prop('hidden', false);

    const r = button.getBoundingClientRect();
    const mw = $menu.outerWidth(), mh = $menu.outerHeight();
    let top = r.bottom + 4;
    if (top + mh > window.innerHeight - 8) top = r.top - mh - 4;
    const left = Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8));
    $menu.css({ top: top + 'px', left: left + 'px' });
}

function closeMenu() {
    $('#row-menu').prop('hidden', true).removeAttr('data-for');
}

function runMenuAction(action, id) {
    closeMenu();
    if (action === 'details') openNote(id);
    else if (action === 'edit') taskEdit(id);
    else if (action === 'delete') startTaskDelete([id]);
    else if (action === 'ev-today') evergreenToToday(id);
    else if (action === 'ev-rename') renameEvergreen(id);
    else runTaskAction(action, [id]);
}

// ---------- Info-Popover ----------

function togglePop(button) {
    const $pop = $('#pop');
    if (!$pop.prop('hidden') && $pop.data('for') === button) {
        hidePop();
        return;
    }
    $pop.html(button.getAttribute('data-info')).prop('hidden', false).data('for', button);
    // Im Dialog muss das Popover im Dialog liegen, sonst liegt es unter dem Backdrop
    const dialog = button.closest('dialog');
    $pop.appendTo(dialog || document.body);
    const r = button.getBoundingClientRect();
    const pw = $pop.outerWidth(), ph = $pop.outerHeight();
    let top = r.top - ph - 8;
    if (top < 8) top = r.bottom + 8;
    const left = Math.max(8, Math.min(r.left + r.width / 2 - pw / 2, window.innerWidth - pw - 8));
    $pop.css({ top: top + 'px', left: left + 'px' });
}

function hidePop() {
    $('#pop').prop('hidden', true).data('for', null);
}

// ---------- Aktionen ----------

// ---------- Rückgängig ----------

// Aktionen außer Löschen gehen erst nach ein paar Sekunden an den Server, bis dahin lässt sich alles zurücknehmen
const UNDO_MS = 5000;
const UNDO_LABELS = {
    'done': 'Erledigt',
    'not-today': 'Nicht heute',
    'to-today': 'Auf heute',
    'tomorrow': 'Auf morgen',
    'next-week': 'Nächste Woche',
};
let pending = null;

function isPending(id) {
    return !!pending && pending.ids.includes(String(id));
}

function snapshotCaches() {
    const keys = [currentView, 'long', 'evergreen'].map(cacheKey).concat([profileKey()]);
    return keys.map(k => [k, localStorage.getItem(k)]);
}

function restoreCaches(snapshot) {
    snapshot.forEach(([k, v]) => {
        try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {}
    });
}

function showUndo(text) {
    const $t = $('#undo');
    $('#undo-text').text(text);
    $t.prop('hidden', false).removeClass('run');
    void $t[0].offsetWidth; // Animation des Balkens neu starten
    $t.addClass('run');
}

function hideUndo() {
    $('#undo').prop('hidden', true).removeClass('run');
}

function commitPending() {
    if (!pending) return;
    const p = pending;
    pending = null;
    clearTimeout(p.timer);
    hideUndo();
    sendTaskAction(p.action, p.ids);
}

function undoPending() {
    if (!pending) return;
    const p = pending;
    pending = null;
    clearTimeout(p.timer);
    hideUndo();
    restoreCaches(p.snapshot);
    rerenderLists();
    updateCounts();
    if (currentView === 'today') renderBudget();
}

// Beim Verlassen der App sofort senden, keepalive überlebt das Schließen
function flushPendingOnHide() {
    if (!pending) return;
    const p = pending;
    pending = null;
    clearTimeout(p.timer);
    hideUndo();
    const config = TASK_ACTIONS[p.action];
    p.ids.forEach(id => {
        try {
            fetch(apiPrefix + config.path(id), {
                method: config.method,
                keepalive: true,
                headers: { 'Authorization': 'Bearer ' + localStorage.getItem('quarto_id_token') },
            });
        } catch (e) {
            sendTaskAction(p.action, [id]);
        }
    });
}

// Ändert Cache und Oberfläche sofort
function applyTaskAction(action, taskIds) {
    if (action === 'done') countDoneLocally(taskIds);
    // In Heute und Arbeit verschwindet ein Task bei jeder Aktion, in Alle nur beim Löschen
    if (isDayView(currentView) || action === 'delete') {
        taskIds.forEach(id => $(`.row[data-id="${id}"]`).addClass('leaving').delay(180).queue(function () { $(this).remove(); }));
        [currentView, 'long', 'evergreen'].forEach(view => {
            const remaining = (readCache(view) || []).filter(t => !taskIds.includes(String(t.id)));
            writeCache(view, remaining);
        });
    }
    if (currentView === 'today') setTimeout(renderBudget, 0);
}

function sendTaskAction(action, taskIds) {
    const config = TASK_ACTIONS[action];
    const requests = taskIds.map(id => $.ajax({
        url: apiPrefix + config.path(id),
        method: config.method,
        contentType: 'application/json',
    }));

    Promise.allSettled(requests).then(results => {
        const failed = results.filter(r => r.status === 'rejected').length;
        if (failed > 0) {
            console.error(`${failed} von ${taskIds.length} Aktionen (${action}) fehlgeschlagen`);
            alert(`${failed} von ${taskIds.length} Aufgaben konnten nicht aktualisiert werden.`);
        }
        reloadCurrentView();
    });
}

// Führt eine Aktion aus: Löschen sofort (hat schon eine Rückfrage), alles andere mit Rückgängig
function runTaskAction(action, taskIds) {
    const config = TASK_ACTIONS[action];
    if (!config || taskIds.length === 0) return;
    taskIds = taskIds.map(String);

    if (action === 'delete') {
        applyTaskAction(action, taskIds);
        sendTaskAction(action, taskIds);
        return;
    }

    commitPending();
    const task = findTask(taskIds[0]);
    const snapshot = snapshotCaches();
    applyTaskAction(action, taskIds);
    pending = { action, ids: taskIds, snapshot, timer: setTimeout(commitPending, UNDO_MS) };
    showUndo(`${UNDO_LABELS[action]}: ${task ? task.name : ''}`);
}

function completeTask(row) {
    const id = row.getAttribute('data-id');
    if (String(id).startsWith('tmp-')) return;
    $(row).addClass('checked');
    setTimeout(() => runTaskAction('done', [id]), 220);
}

function startTaskDelete(taskIds) {
    const label = taskIds.length === 1
        ? `"${$(`.row[data-id="${taskIds[0]}"]`).attr('data-name') || ''}"`
        : `${taskIds.length} Aufgaben`;

    $('#toBeDeletedTaskName').text(label);
    $('#toBeDeletedTaskButton').off('click').on('click', function () {
        closeDialog('#deleteTaskModal');
        runTaskAction('delete', taskIds);
    });
    openDialog('#deleteTaskModal');
}

// ---------- Dialoge ----------

function openDialog(sel) {
    const d = $(sel)[0];
    if (d && !d.open) d.showModal();
}

function closeDialog(sel) {
    const d = $(sel)[0];
    if (d && d.open) d.close();
    hidePop();
}

// Ein Dialog für Neu und Bearbeiten
let editingSubtasks = [];

function prepareTaskForm() {
    // Arbeit braucht weder Priorität noch Dauer
    const workForm = kontextFor('all') === 'arbeit';
    $('#taskModal .private-only').prop('hidden', workForm);
    $('#selectPriority, #inputDuration').prop('required', !workForm);
}

function openNewTask() {
    emptyForm();
    $('#taskModalTitle').text(kontextFor('all') === 'arbeit' ? 'Neue Arbeitsaufgabe' : 'Neue Aufgabe');
    prepareTaskForm();
    openDialog('#taskModal');
    setTimeout(() => $('#inputTask').trigger('focus'), 50);
}

function taskEdit(taskId) {
    $.ajax({
        url: apiPrefix + `user/${$.cookie('user_id')}/task/${taskId}`,
        method: 'GET',
        dataType: 'json',
        success: function (item) {
            emptyForm();
            $('#taskModalTitle').text('Aufgabe bearbeiten');
            $('#editTaskId').val(item.id);
            $('#inputTask').val(item.name);
            $('#inputNote').val(item.notiz || '');
            editingSubtasks = item.subtasks || [];
            $('#inputSubtasks').val(editingSubtasks.map(s => s.name).join('\n'));
            if (item.priorityLevel && item.priorityLevel.id) $('#selectPriority').val(item.priorityLevel.id);
            $('#pickDueDate').val(item.dueDate);
            $('#inputFrequency').val(item.rhythm);
            $('#inputDuration').val(item.duration);
            prepareTaskForm();
            openDialog('#taskModal');
        },
        error: function (xhr, status, error) {
            console.error('Error fetching task:', status, error);
        }
    });
}

function submitTaskForm() {
    if ($('#editTaskId').val()) saveTaskEdit(); else addTask();
}

function saveTaskEdit() {
    const taskId = $('#editTaskId').val();
    const isWork = kontextFor('all') === 'arbeit';
    const task = {
        priorityLevel: { id: isWork ? null : parseInt($('#selectPriority').val()) },
        name: $('#inputTask').val(),
        notiz: $('#inputNote').val().trim(),
        subtasks: linesToSubtasks($('#inputSubtasks').val(), editingSubtasks),
        duration: isWork ? null : parseInt($('#inputDuration').val()),
        dueDate: $('#pickDueDate').val(),
        rhythm: $('#inputFrequency').val().trim(),
        today: 0
    };

    $.ajax({
        url: apiPrefix + `user/${$.cookie('user_id')}/task/${taskId}`,
        method: 'PUT',
        contentType: 'application/json',
        data: JSON.stringify(task),
        success: function () {
            closeDialog('#taskModal');
            reloadCurrentView();
        },
        error: function (xhr, status, error) {
            console.error('Error updating task:', status, error);
            alert('Speichern fehlgeschlagen.');
        }
    });
}

function addTask() {
    const isWork = kontextFor('all') === 'arbeit';
    const task = {
        priority_level_id: isWork ? null : $('#selectPriority').val(),
        user_id: $.cookie('user_id'),
        name: $('#inputTask').val(),
        notiz: $('#inputNote').val().trim(),
        subtasks: linesToSubtasks($('#inputSubtasks').val(), []),
        duration: isWork ? null : $('#inputDuration').val(),
        dueDate: $('#pickDueDate').val(),
        rhythm: $('#inputFrequency').val().trim(),
        today: 0,
        kontext: kontextFor('all')
    };

    $.ajax({
        url: apiPrefix + 'task',
        method: 'POST',
        contentType: 'application/json',
        data: JSON.stringify(task),
        success: function () {
            closeDialog('#taskModal');
            emptyForm();
            reloadCurrentView();
        },
        error: function (xhr, status, error) {
            console.error('Error adding task:', status, error);
            alert('Anlegen fehlgeschlagen.');
        }
    });
}

function emptyForm() {
    $('#editTaskId').val('');
    $('#inputTask, #inputNote, #inputSubtasks, #pickDueDate, #inputFrequency, #inputDuration').val('');
    $('#selectPriority').val('4');
    editingSubtasks = [];
}

// ---------- Reihenfolge per Drag & Drop ----------

let sortables = null;

function initSortable(view) {
    if (typeof Sortable === 'undefined') return;
    if (!sortables) {
        const common = {
            draggable: '.row',
            animation: 150,
            delay: 220,
            delayOnTouchOnly: true,
            filter: '.check, .more, .subtask, a',
            preventOnFilter: false,
            ghostClass: 'ghost',
            onEnd: onDrop,
        };
        sortables = [
            Sortable.create(document.getElementById('task-list'), {
                ...common,
                group: { name: 'tasks', pull: true, put: true },
            }),
            // In die langfristige Liste dürfen nur langfristige To-dos zurück
            Sortable.create(document.getElementById('long-list'), {
                ...common,
                group: { name: 'tasks', pull: true, put: (to, from, dragEl) => dragEl.dataset.long === 'true' },
            }),
        ];
    }
    sortables.forEach(s => s.option('disabled', !isDayView(view)));
}

function onDrop(evt) {
    const fromKey = evt.from.id === 'long-list' ? 'long' : currentView;
    const toKey = evt.to.id === 'long-list' ? 'long' : currentView;
    if (fromKey === toKey && evt.oldIndex === evt.newIndex) return;

    const id = evt.item.getAttribute('data-id');
    const fromCache = readCache(fromKey) || [];
    const task = fromCache.find(t => String(t.id) === id);
    if (!task) return;

    const toCache = fromKey === toKey ? fromCache : (readCache(toKey) || []);
    const byId = Object.fromEntries(toCache.map(t => [String(t.id), t]));
    byId[id] = task;
    const ids = [...evt.to.querySelectorAll('.row[data-id]')].map(r => r.getAttribute('data-id'));
    const idx = ids.indexOf(id);

    const prev = byId[ids[idx - 1]]?.ordnung;
    const next = byId[ids[idx + 1]]?.ordnung;
    let ordnung;
    if (prev == null && next == null) ordnung = 1000;
    else if (prev == null) ordnung = next - 1000;
    else if (next == null) ordnung = prev + 1000;
    else ordnung = (prev + next) / 2;

    task.ordnung = ordnung;
    task.today = toKey === currentView ? 1 : 0;
    writeCache(toKey, ids.map(i => byId[i]).filter(Boolean));
    if (fromKey !== toKey) {
        writeCache(fromKey, fromCache.filter(t => String(t.id) !== id));
    }
    renderTable(readCache(currentView) || [], currentView);
    renderLong(readCache('long') || []);

    $.ajax({
        url: apiPrefix + `user/${$.cookie('user_id')}/task/${id}`,
        method: 'PUT',
        contentType: 'application/json',
        data: JSON.stringify({ ordnung: ordnung, today: task.today }),
        error: function () {
            alert('Verschieben konnte nicht gespeichert werden.');
            reloadCurrentView();
        }
    });
}

// ---------- Langfristige Liste ----------

function loadLong() {
    const cached = readCache('long');
    if (cached) {
        renderLong(cached);
    }
    $.ajax({
        url: apiPrefix + 'user/' + $.cookie('user_id') + '/tasks/long?kontext=' + kontextFor('long'),
        method: 'GET',
        dataType: 'json',
        success: function (response) {
            const changed = JSON.stringify(response) !== JSON.stringify(cached);
            writeCache('long', response);
            if (changed && isDayView(currentView)) {
                renderLong(response);
            }
        },
        error: function (xhr, status, error) {
            console.error('Error fetching long-term tasks:', status, error);
        }
    });
}

function renderLong(items) {
    items = items.filter(t => !isPending(t.id));
    const $list = $('#long-list');
    $list.empty();
    $('#long-count').text(items.length || '');
    if (items.length === 0) {
        $list.append('<div class="empty">Nichts geplant</div>');
    } else {
        items.forEach(item => $list.append(buildRow(item, currentView, true)));
    }
    initSortable(currentView);
}

function setLongCollapsed(collapsed) {
    $('#long-section').toggleClass('collapsed', collapsed);
    try { localStorage.setItem('quarto_long_collapsed', collapsed ? '1' : ''); } catch (e) {}
}

// ---------- Budget ----------

function profileKey() {
    return `quarto_profile_${$.cookie('user_id')}`;
}

function loadBudget() {
    renderBudget();
    $.ajax({
        url: apiPrefix + `user/${$.cookie('user_id')}/profile`,
        method: 'GET',
        dataType: 'json',
        success: function (p) {
            try { localStorage.setItem(profileKey(), JSON.stringify(p)); } catch (e) {}
            renderBudget();
        }
    });
}

// Hinweis in Heute und Arbeit, solange ein Urlaub ansteht oder läuft
function renderVacation() {
    const p = readRaw(profileKey());
    const show = isDayView(currentView) && p && p.vacationFrom && p.vacationTo && daysUntil(p.vacationTo) >= 0;
    $('#vacation-banner').prop('hidden', !show);
    if (!show) return;
    const fmt = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' }); };
    const days = daysUntil(p.vacationTo) - daysUntil(p.vacationFrom) + 1;
    $('#vacation-text').text(daysUntil(p.vacationFrom) <= 0
        ? `Urlaub bis ${fmt(p.vacationTo)}, danach rücken die Fälligkeiten um ${days} Tage`
        : `Urlaub ab ${fmt(p.vacationFrom)} bis ${fmt(p.vacationTo)}`);
}

function renderBudget() {
    renderVacation();
    const p = readRaw(profileKey());
    const openMinutes = (readRaw(`quarto_today_privat_${$.cookie('user_id')}`) || [])
        .reduce((sum, t) => sum + (Number(t.duration) || 0), 0);
    if (!p || p.budgetToday == null) {
        $('#budget-line, #side-budget-value').text(`${openMinutes} min offen`);
        return;
    }
    const budget = Number(p.budgetToday) || 0;
    const daily = Number(p.dailyLimit) || budget;
    const carry = Math.max(0, budget - daily);

    // Balken = Budget minus offene Minuten. Was nicht verplant ist, zählt von Anfang an als geschafft,
    // sind alle Aufgaben abgehakt, ist er voll
    const filled = Math.max(0, budget - openMinutes);
    $('#budget-line').text(`${filled} / ${budget} min` + (carry ? ` · +${carry} Übertrag` : ''));
    $('#side-budget-value').text(`${filled} / ${budget} min`);
    $('.bar .fill').css('width', Math.min(100, filled / Math.max(budget, 1) * 100) + '%');
    $('.bar .carry').css('width', '0%');
}

// Erledigte Minuten sofort zählen, der Server bestätigt beim nächsten Laden
function countDoneLocally(taskIds) {
    const p = readRaw(profileKey());
    if (!p) return;
    const minutes = taskIds.map(findTask)
        .filter(t => t && !t.longTerm && (t.kontext || 'privat') === 'privat')
        .reduce((sum, t) => sum + (Number(t.duration) || 0), 0);
    if (!minutes) return;
    p.doneToday = (Number(p.doneToday) || 0) + minutes;
    try { localStorage.setItem(profileKey(), JSON.stringify(p)); } catch (e) {}
}

// ---------- Zähler in der Seitenleiste ----------

function updateCounts() {
    const uid = $.cookie('user_id');
    const today = readRaw(`quarto_today_privat_${uid}`);
    const work = readRaw(`quarto_work_arbeit_${uid}`);
    $('#count-today').text(today && today.length ? today.length : '');
    $('#count-work').text(work && work.length ? work.length : '');
}

// ---------- Sync zwischen Geräten ----------

// Nicht neu zeichnen, während ein Menü oder Dialog offen ist, gezogen oder getippt wird
function safeRefresh() {
    if (!isAppPage() || currentView === 'account' || pending) return;
    if (!$('#row-menu').prop('hidden') || $('.sortable-chosen').length || $('dialog[open]').length) return;
    if ($(document.activeElement).is('#longInput, #evergreenInput') && document.activeElement.value) return;
    reloadCurrentView();
}

document.addEventListener('visibilitychange', function () {
    if (document.hidden) flushPendingOnHide();
    else safeRefresh();
});
window.addEventListener('pagehide', flushPendingOnHide);
window.addEventListener('focus', safeRefresh);

setInterval(function () {
    if (!document.hidden) safeRefresh();
}, 60000);

// ---------- Notizen und Unteraufgaben ----------

function linkify(text) {
    return text.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

// Aufgeklappte Tasks bleiben auch nach dem Neuzeichnen offen
const openTasks = new Set();

function rerenderLists() {
    renderTable(readCache(currentView) || [], currentView);
    if (isDayView(currentView)) renderLong(readCache('long') || []);
}

function updateCachedTask(id, change) {
    let updated = null;
    // Jede Liste nur einmal, sonst kippt ein Umschalter in Alle zweimal zurück
    [...new Set([currentView, 'long', 'all'])].forEach(key => {
        const items = readCache(key);
        if (!items) return;
        items.forEach(t => {
            if (String(t.id) === String(id)) {
                change(t);
                updated = t;
            }
        });
        writeCache(key, items);
    });
    return updated;
}

function putTask(id, body) {
    $.ajax({
        url: apiPrefix + `user/${$.cookie('user_id')}/task/${id}`,
        method: 'PUT',
        contentType: 'application/json',
        data: JSON.stringify(body),
        error: function () {
            alert('Änderung konnte nicht gespeichert werden.');
            reloadCurrentView();
        }
    });
}

function toggleSubtask(button) {
    const taskId = button.getAttribute('data-task');
    const subId = button.getAttribute('data-sub');
    const current = ((findTask(taskId) || {}).subtasks || []).find(s => String(s.id) === subId);
    const done = !(current && current.done);
    const task = updateCachedTask(taskId, t => {
        t.subtasks = (t.subtasks || []).map(s => String(s.id) === subId ? { ...s, done: done } : s);
    });
    rerenderLists();
    if (task) putTask(taskId, { subtasks: task.subtasks });
}

// Eine Zeile pro Unteraufgabe, unveränderte Zeilen behalten ihr Häkchen
function linesToSubtasks(text, old) {
    const byName = new Map((old || []).map(s => [s.name, s]));
    return text.split('\n').map(l => l.trim()).filter(Boolean).map(name =>
        byName.get(name) || { id: Math.random().toString(16).slice(2, 10), name: name, done: false });
}

function findTask(id) {
    for (const key of [currentView, 'long', 'all']) {
        const task = (readCache(key) || []).find(t => String(t.id) === String(id));
        if (task) return task;
    }
    return null;
}

function openNote(id) {
    const task = findTask(id);
    $('#noteTaskId').val(id);
    $('#noteModalTitle').text(task ? task.name : 'Details');
    $('#noteSubtasks').val(task ? (task.subtasks || []).map(s => s.name).join('\n') : '');
    $('#noteText').val(task && task.notiz ? task.notiz : '');
    openDialog('#noteModal');
}

function saveNote() {
    const id = $('#noteTaskId').val();
    const notiz = $('#noteText').val().trim();
    const old = (findTask(id) || {}).subtasks;
    const subtasks = linesToSubtasks($('#noteSubtasks').val(), old);
    updateCachedTask(id, t => {
        t.notiz = notiz || null;
        t.subtasks = subtasks;
    });
    if (subtasks.length || notiz) openTasks.add(String(id));
    closeDialog('#noteModal');
    rerenderLists();
    putTask(id, { notiz: notiz, subtasks: subtasks });
}

// ---------- Konto ----------

function showAccountMessage(text, ok) {
    $('#accountMessage').toggleClass('ok', ok).toggleClass('error', !ok).text(text);
}

function loadAccount() {
    $('#accountMessage').text('');
    $.ajax({
        url: apiPrefix + `user/${$.cookie('user_id')}/profile`,
        method: 'GET',
        dataType: 'json',
        success: function (p) {
            try { localStorage.setItem(profileKey(), JSON.stringify(p)); } catch (e) {}
            $('#dailyLimit').val(p.dailyLimit);
            $('#maxLimit').val(p.maxLimit);
            $('#budgetToday').text(p.budgetToday);
            $('#vacationFrom').val(p.vacationFrom || '');
            $('#vacationTo').val(p.vacationTo || '');
            loadDemand();
            renderPush();
        },
        error: function () {
            showAccountMessage('Konto konnte nicht geladen werden.', false);
        }
    });
}

// ---------- Bedarf ----------

// Rhythmus in Tagen: 7 -> 7, do -> 7, 15. und eom -> ein Monat, 0 oder leer -> einmalig
function intervalDays(rhythm) {
    const r = String(rhythm == null ? '' : rhythm).trim().toLowerCase();
    if (/^\d+$/.test(r)) return Number(r) > 0 ? Number(r) : null;
    if (/^\d{1,2}\.$/.test(r) || r === 'eom') return 30.44;
    if (/^[a-zäöü]+$/.test(r) && WEEKDAY_SHORT[r.slice(0, 2)] !== undefined) return 7;
    return null;
}

function formatMinutes(value) {
    return value.toLocaleString('de-DE', { maximumFractionDigits: 1 });
}

function loadDemand() {
    $.ajax({
        url: apiPrefix + 'user/' + $.cookie('user_id') + '/tasks?kontext=privat',
        method: 'GET',
        dataType: 'json',
        success: renderDemand,
    });
}

function renderDemand(tasks) {
    const items = (tasks || [])
        .filter(t => !t.spontan && !t.longTerm && Number(t.duration) > 0)
        .map(t => ({ task: t, days: intervalDays(t.rhythm) }))
        .filter(x => x.days)
        .map(x => ({ ...x, perDay: Number(x.task.duration) / x.days }))
        .sort((a, b) => b.perDay - a.perDay);
    const total = items.reduce((sum, x) => sum + x.perDay, 0);
    const daily = parseInt($('#dailyLimit').val()) || 0;
    const needed = Math.ceil(total);

    $('#demand').prop('hidden', items.length === 0);
    $('#demand-value').text(`${formatMinutes(total)} min/Tag · Limit ${daily}`).toggleClass('overdue', total > daily);
    if (total > daily) {
        $('#demand-hint').html(`Rückstand wächst. Limit auf ${needed} erhöhen oder Rhythmen strecken. `
            + `<button type="button" class="link-btn" id="demand-apply">Limit auf ${needed} setzen</button>`);
    } else {
        $('#demand-hint').text(`Passt. ${formatMinutes(daily - total)} min/Tag Luft für spontane Aufgaben und Rückstand.`);
    }
    $('#demand-list').html(items.slice(0, 8).map(x =>
        `<div class="demand-row"><span class="name">${escapeHtml(x.task.name)}</span>`
        + `<span class="mono muted">${x.task.duration}m / ${escapeHtml(x.task.rhythm)}</span>`
        + `<span class="mono">${formatMinutes(x.perDay)}</span></div>`).join(''));
}

function createQuickKey() {
    if (!window.confirm('Neuen Schlüssel erzeugen? Ein bestehender Kurzbefehl funktioniert dann erst wieder mit dem neuen Schlüssel.')) return;
    $.ajax({
        url: apiPrefix + `user/${$.cookie('user_id')}/quick-key`,
        method: 'POST',
        dataType: 'json',
        success: function (r) {
            $('#quickKey').text(r.key);
            $('#quickUrl').text(apiPrefix + 'quick');
            $('#quickKeyResult').prop('hidden', false);
        },
        error: function () { alert('Schlüssel konnte nicht erzeugt werden.'); },
    });
}

// ---------- Push ----------

function pushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

function urlB64ToUint8Array(text) {
    const raw = atob((text + '='.repeat((4 - text.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, c => c.charCodeAt(0));
}

async function currentSubscription() {
    const reg = await navigator.serviceWorker.getRegistration('./');
    return reg ? reg.pushManager.getSubscription() : null;
}

async function renderPush(message) {
    const $s = $('#pushStatus');
    $('#pushEnable, #pushTest, #pushDisable').prop('hidden', true);
    if (!pushSupported()) {
        $s.text('Auf dem iPhone nur in der App vom Homescreen, nicht in Safari.');
        return;
    }
    if (Notification.permission === 'denied') {
        $s.text('Mitteilungen sind für Quarto blockiert. In den Einstellungen unter Mitteilungen wieder erlauben.');
        return;
    }
    const sub = await currentSubscription();
    $('#pushEnable').prop('hidden', !!sub);
    $('#pushTest, #pushDisable').prop('hidden', !sub);
    $s.text(message || (sub ? 'Aktiv auf diesem Gerät.' : 'Auf diesem Gerät aus.'));
}

async function enablePush() {
    try {
        // Muss als Erstes im Klick passieren, sonst blockiert iOS die Abfrage
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
            renderPush('Ohne Erlaubnis keine Benachrichtigung.');
            return;
        }
        const reg = await navigator.serviceWorker.register('./sw.js');
        await navigator.serviceWorker.ready;
        const { publicKey } = await $.ajax({ url: apiPrefix + 'push/key', method: 'GET', dataType: 'json' });
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(publicKey) });
        await $.ajax({
            url: apiPrefix + `user/${$.cookie('user_id')}/push`,
            method: 'POST',
            contentType: 'application/json',
            data: JSON.stringify({ subscription: sub.toJSON() }),
        });
        renderPush('Aktiv. Mit „Test senden“ kannst du es gleich ausprobieren.');
    } catch (e) {
        console.error(e);
        renderPush('Aktivieren hat nicht geklappt.');
    }
}

async function disablePush() {
    const sub = await currentSubscription();
    if (sub) {
        $.ajax({
            url: apiPrefix + `user/${$.cookie('user_id')}/push`,
            method: 'DELETE',
            contentType: 'application/json',
            data: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
    }
    renderPush('Auf diesem Gerät aus.');
}

function testPush() {
    $.ajax({
        url: apiPrefix + `user/${$.cookie('user_id')}/push/test`,
        method: 'POST',
        dataType: 'json',
        success: r => renderPush(r.sent ? `Gesendet an ${r.sent} Gerät${r.sent === 1 ? '' : 'e'}.` : 'Kein Gerät erreicht.'),
        error: () => renderPush('Test fehlgeschlagen.'),
    });
}

function saveAccount() {
    $.ajax({
        url: apiPrefix + `user/${$.cookie('user_id')}/profile`,
        method: 'PUT',
        contentType: 'application/json',
        dataType: 'json',
        data: JSON.stringify({
            dailyLimit: parseInt($('#dailyLimit').val()),
            maxLimit: parseInt($('#maxLimit').val()),
            vacationFrom: $('#vacationFrom').val() || null,
            vacationTo: $('#vacationTo').val() || null,
        }),
        success: function (p) {
            try { localStorage.setItem(profileKey(), JSON.stringify(p)); } catch (e) {}
            $('#budgetToday').text(p.budgetToday);
            showAccountMessage('Gespeichert.', true);
            loadDemand();
        },
        error: function (xhr) {
            showAccountMessage((xhr.responseJSON && xhr.responseJSON.message) || 'Speichern fehlgeschlagen.', false);
        }
    });
}

// ---------- Deadlines ----------

const WEEKDAY_SHORT = { so: 0, mo: 1, di: 2, mi: 3, do: 4, fr: 5, sa: 6 };

function startOfToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
}

function addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
}

function isoDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// "Diagramm bis fr" -> { name: "Diagramm", deadline: "2026-11-27" }
function parseDeadline(text) {
    const m = text.match(/^(.*\S)\s+bis\s+(.+)$/i);
    if (!m) return { name: text, deadline: null };
    const when = m[2].trim().toLowerCase();
    const today = startOfToday();
    let d = null;
    if (when === 'heute') d = today;
    else if (when === 'morgen') d = addDays(today, 1);
    else if (when === 'übermorgen') d = addDays(today, 2);
    else if (/^[a-zäöü]+$/.test(when) && WEEKDAY_SHORT[when.slice(0, 2)] !== undefined) {
        d = addDays(today, (WEEKDAY_SHORT[when.slice(0, 2)] - today.getDay() + 7) % 7);
    } else {
        const dm = when.match(/^(\d{1,2})\.(\d{1,2})\.?(\d{2}|\d{4})?$/);
        if (dm) {
            const year = dm[3] ? Number(dm[3].length === 2 ? '20' + dm[3] : dm[3]) : today.getFullYear();
            d = new Date(year, Number(dm[2]) - 1, Number(dm[1]));
            if (!dm[3] && d < today) d.setFullYear(year + 1);
        }
    }
    if (!d || isNaN(d)) return { name: text, deadline: null };
    return { name: m[1].trim(), deadline: isoDate(d) };
}

function daysUntil(iso) {
    const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    return Math.round((new Date(y, m - 1, d) - startOfToday()) / 86400000);
}

// Kurz für schmale Zeilen: heute, morgen, gestern, in 5d, -3d
function shortDays(days) {
    if (days === 0) return 'heute';
    if (days === 1) return 'morgen';
    if (days === -1) return 'gestern';
    return days > 1 ? `in ${days}d` : `${days}d`;
}

// ---------- Schnelle Eingabe ----------

// Legt To-dos an, mehrere durch Komma getrennt. kind: 'today' (spontan) oder 'long' (langfristig)
function addQuick(kind, $input) {
    const names = $input.val().split(',').map(s => s.trim()).filter(Boolean);
    if (names.length === 0) return;
    $input.val('');
    createQuick(kind, names);
}

function createQuick(kind, names) {
    const key = kind === 'long' ? 'long' : currentView;
    const cached = readCache(key) || [];
    const maxOrder = cached.reduce((m, t) => Math.max(m, t.ordnung || 0), 0);
    const created = names
        .map(raw => kind === 'long' ? parseDeadline(raw) : { name: raw, deadline: null })
        .map(({ name, deadline }, i) => ({
            deadline: deadline,
            id: `tmp-${Date.now()}-${i}`,
            name: name,
            dueDate: null,
            priorityLevel: { id: null, name: null },
            today: kind === 'today' ? 1 : 0,
            spontan: kind === 'today',
            longTerm: kind === 'long',
            ordnung: maxOrder + 1000 * (i + 1),
        }));
    const updated = cached.concat(created);
    writeCache(key, updated);
    if (kind === 'long') {
        renderLong(updated);
    } else if (isDayView(currentView)) {
        renderTable(updated, currentView);
    }

    const requests = created.map(t => $.ajax({
        url: apiPrefix + 'task',
        method: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({
            user_id: $.cookie('user_id'),
            name: t.name,
            spontan: t.spontan,
            longTerm: t.longTerm,
            deadline: t.deadline,
            kontext: kontextFor(key === 'long' ? 'long' : currentView),
            ordnung: t.ordnung,
        }),
    }));

    Promise.allSettled(requests).then(results => {
        const failed = results.filter(r => r.status === 'rejected').length;
        if (failed > 0) {
            alert(`${failed} von ${names.length} To-dos konnten nicht angelegt werden.`);
        }
        reloadCurrentView();
    });
}

// ---------- Evergreens ----------

function loadEvergreens() {
    renderChips();
    $.ajax({
        url: apiPrefix + 'user/' + $.cookie('user_id') + '/tasks?kontext=privat',
        method: 'GET',
        dataType: 'json',
        success: function (response) {
            writeCache('evergreen', response.filter(t => t.evergreen));
            if (currentView === 'today') renderChips();
        }
    });
}

function evergreens() {
    return (readCache('evergreen') || []).slice().sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

function todayNames() {
    return new Set((readRaw(`quarto_today_privat_${$.cookie('user_id')}`) || []).map(t => t.name.trim().toLowerCase()));
}

// Chips unter dem Spontan-Feld, grau solange der Evergreen schon auf heute steht
function renderChips() {
    const items = evergreens();
    const onToday = todayNames();
    $('#evergreen-chips').html(items.map(t => {
        const used = onToday.has(t.name.trim().toLowerCase());
        return `<button type="button" class="chip-btn${used ? ' used' : ''}" data-name="${escapeHtml(t.name)}"${used ? ' disabled' : ''}>`
            + `${used ? '<i class="bi bi-check"></i>' : '<i class="bi bi-plus"></i>'}${escapeHtml(t.name)}</button>`;
    }).join('')).toggleClass('empty-chips', items.length === 0);
}

function renderEvergreens(items) {
    items = items.slice().sort((a, b) => a.name.localeCompare(b.name, 'de'));
    const onToday = todayNames();
    $('#evergreen-count').text(items.length || '');
    $('#evergreen-list').html(items.length === 0
        ? '<div class="empty">Noch keine Evergreens</div>'
        : items.map(t => `
            <div class="row ev-row" data-id="${t.id}" data-name="${escapeHtml(t.name)}">
                <span class="ev-icon"><i class="bi bi-arrow-repeat"></i></span>
                <div class="row-main"><div class="row-line"><span class="name">${escapeHtml(t.name)}</span></div></div>
                <div class="meta">${onToday.has(t.name.trim().toLowerCase()) ? '<span class="chip">heute</span>' : ''}</div>
                <button type="button" class="more" aria-label="Mehr"><i class="bi bi-three-dots"></i></button>
            </div>`).join(''));
}

// Legt aus einem Evergreen ein spontanes To-do für heute an
function evergreenToToday(id) {
    const ev = (readCache('evergreen') || []).find(t => String(t.id) === String(id));
    if (!ev) return;
    if (currentView === 'today') {
        createQuick('today', [ev.name]);
        return;
    }
    const key = `quarto_today_privat_${$.cookie('user_id')}`;
    const today = readRaw(key) || [];
    today.push({ id: `tmp-${Date.now()}`, name: ev.name, spontan: true, today: 1, priorityLevel: { id: null, name: null } });
    try { localStorage.setItem(key, JSON.stringify(today)); } catch (e) {}
    updateCounts();
    renderEvergreens(readCache('evergreen') || []);
    $.ajax({
        url: apiPrefix + 'task',
        method: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({ user_id: $.cookie('user_id'), name: ev.name, spontan: true, kontext: 'privat' }),
        error: function () { alert('Konnte nicht auf heute gesetzt werden.'); },
    });
}

function addEvergreens() {
    const names = $('#evergreenInput').val().split(',').map(s => s.trim()).filter(Boolean);
    if (names.length === 0) return;
    $('#evergreenInput').val('');
    const created = names.map((name, i) => ({ id: `tmp-${Date.now()}-${i}`, name: name, evergreen: true }));
    const items = (readCache('evergreen') || []).concat(created);
    writeCache('evergreen', items);
    renderEvergreens(items);

    const requests = names.map(name => $.ajax({
        url: apiPrefix + 'task',
        method: 'POST',
        contentType: 'application/json',
        data: JSON.stringify({ user_id: $.cookie('user_id'), name: name, evergreen: true, kontext: 'privat' }),
    }));
    Promise.allSettled(requests).then(results => {
        if (results.some(r => r.status === 'rejected')) alert('Nicht alle Evergreens konnten angelegt werden.');
        reloadCurrentView();
    });
}

function renameEvergreen(id) {
    const items = readCache('evergreen') || [];
    const ev = items.find(t => String(t.id) === String(id));
    if (!ev || String(id).startsWith('tmp-')) return;
    const name = (window.prompt('Neuer Name', ev.name) || '').trim();
    if (!name || name === ev.name) return;
    ev.name = name;
    writeCache('evergreen', items);
    renderEvergreens(items);
    putTask(id, { name: name });
}

// ---------- Helfer ----------

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ---------- Bedienung ----------

function initUi() {
    setLongCollapsed(localStorage.getItem('quarto_long_collapsed') === '1');
    updateCounts();

    $(document).on('click', '[data-view]', function (event) {
        event.preventDefault();
        setView(this.getAttribute('data-view'));
    });

    $('#kontext-toggle').on('click', 'button', function () {
        setAllKontext(this.getAttribute('data-kontext'));
    });

    $('#long-add').on('submit', function (event) {
        event.preventDefault();
        addQuick('long', $('#longInput'));
    });

    $('#evergreen-add').on('submit', function (event) {
        event.preventDefault();
        addEvergreens();
    });
    $('#evergreen-chips').on('click', '.chip-btn:not(.used)', function () {
        $(this).addClass('used').prop('disabled', true);
        createQuick('today', [this.getAttribute('data-name')]);
    });

    $('#long-toggle').on('click', function () {
        setLongCollapsed(!$('#long-section').hasClass('collapsed'));
    });

    $('#addTaskButton').on('click', openNewTask);
    $('#undo-btn').on('click', undoPending);
    $('#task-form').on('submit', function (event) {
        event.preventDefault();
        submitTaskForm();
    });
    $('#note-form').on('submit', function (event) {
        event.preventDefault();
        saveNote();
    });
    $('#account-form').on('submit', function (event) {
        event.preventDefault();
        saveAccount();
    });
    $('#logoutButton').on('click', logout);
    $('#quickKeyButton').on('click', createQuickKey);
    $('#pushEnable').on('click', enablePush);
    $('#pushDisable').on('click', disablePush);
    $('#pushTest').on('click', testPush);
    $('#quickKeyCopy').on('click', function () {
        const btn = this;
        navigator.clipboard.writeText($('#quickKey').text()).then(() => { btn.textContent = 'Kopiert'; });
    });
    $(document).on('click', '#demand-apply', function () {
        const value = Math.min(240, Number(this.textContent.replace(/\D/g, '')));
        $('#dailyLimit').val(value);
        if ((parseInt($('#maxLimit').val()) || 0) < value) $('#maxLimit').val(value);
        saveAccount();
    });

    // Zeilen: Häkchen, Menü, Unteraufgaben, Aufklappen
    $(document).on('click', '.row .check', function (event) {
        event.stopPropagation();
        completeTask($(this).closest('.row')[0]);
    });
    $(document).on('click', '.row .more', function (event) {
        event.stopPropagation();
        openMenu(this);
    });
    $(document).on('click', '.subtask', function (event) {
        event.stopPropagation();
        toggleSubtask(this);
    });
    $(document).on('click', '.row.has-detail .row-main', function (event) {
        if ($(event.target).closest('a, .subtask').length) return;
        const id = $(this).closest('.row').attr('data-id');
        if (openTasks.has(id)) openTasks.delete(id); else openTasks.add(id);
        rerenderLists();
    });
    // Ohne Details öffnet ein Tipp auf den Namen das Bearbeiten
    $(document).on('click', '.row:not(.has-detail) .row-main', function () {
        const $row = $(this).closest('.row');
        const id = $row.attr('data-id');
        if (String(id).startsWith('tmp-')) return;
        if ($row.hasClass('ev-row')) {
            renameEvergreen(id);
            return;
        }
        if (currentView === 'all') taskEdit(id); else openNote(id);
    });

    $('#row-menu').on('click', 'button', function (event) {
        event.stopPropagation();
        runMenuAction(this.getAttribute('data-action'), $('#row-menu').attr('data-for'));
    });

    $(document).on('click', '.info-btn', function (event) {
        event.preventDefault();
        event.stopPropagation();
        togglePop(this);
    });

    // Klick daneben schließt Menü und Popover
    $(document).on('click', function (event) {
        if (!$(event.target).closest('#row-menu, .more').length) closeMenu();
        if (!$(event.target).closest('#pop, .info-btn').length) hidePop();
    });
    $(window).on('resize scroll', function () { closeMenu(); hidePop(); });

    // Dialoge: Abbrechen-Knopf und Klick auf den Hintergrund
    $(document).on('click', '[data-close]', function () {
        closeDialog($(this).closest('dialog'));
    });
    $('dialog').on('click', function (event) {
        if (event.target === this) closeDialog(this);
    });
    $('dialog').on('close', hidePop);

    // Tastenkürzel auf dem Mac: N neues einmaliges To-do, Esc raus
    $(document).on('keydown', function (event) {
        const typing = $(event.target).is('input, textarea, select');
        if (event.key === 'Escape') {
            closeMenu();
            hidePop();
            if (typing) event.target.blur();
            return;
        }
        if (!typing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && pending) {
            event.preventDefault();
            undoPending();
            return;
        }
        if (typing || event.metaKey || event.ctrlKey || event.altKey || $('dialog[open]').length) return;
        if (!isDayView(currentView)) {
            if (currentView === 'all' && event.key.toLowerCase() === 'n') {
                event.preventDefault();
                openNewTask();
            }
            return;
        }
        if (event.key.toLowerCase() === 'n' || event.key.toLowerCase() === 'l') {
            event.preventDefault();
            setLongCollapsed(false);
            $('#longInput').trigger('focus');
        }
    });
}
