let apiPrefix = "https://vs7ubni3p3.execute-api.eu-central-1.amazonaws.com/";

// Aktuelle Ansicht: 'today' oder 'all'
let currentView = 'today';

// Ausgewählte Task-IDs für Mehrfachbearbeitung
const selectedIds = new Set();

// Alle Aktionen an einer Stelle, für Einzel- und Mehrfachbearbeitung
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

// App kommt aus dem Hintergrund zurück
document.addEventListener('visibilitychange', function () {
    if (!document.hidden && localStorage.getItem('quarto_refresh_token') && tokenExpiresSoon()) {
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

// ---------- Ansichten ----------

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
    allKontext = kontext;
    try { localStorage.setItem('quarto_all_kontext', kontext); } catch (e) {}
    reloadCurrentView();
}

const VIEWS = {
    today: { link: '#today-link', title: 'Heutige Aufgaben', hash: '#heute' },
    work:  { link: '#work-link',  title: 'Arbeit',           hash: '#arbeit' },
    all:   { link: '#all-link',   title: 'Alle Aufgaben',    hash: '#alle' },
    account: { link: '#account-link', title: 'Konto',         hash: '#konto' },
};

function setView(view) {
    currentView = view;
    $('.nav-link').removeClass('active');
    $(VIEWS[view].link).addClass('active');
    $('.table-header').text(VIEWS[view].title);
    // Ansicht in der URL merken, damit ein Reload auf derselben Seite bleibt
    history.replaceState(null, '', VIEWS[view].hash);
    reloadCurrentView();
}

function reloadCurrentView() {
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
}

// Zeigt sofort den Cache und lädt im Hintergrund den aktuellen Stand
function loadView(view) {
    const isAccount = view === 'account';
    $('#account-section').toggle(isAccount);
    $('#card-content > table').toggle(!isAccount);
    if (isAccount) {
        $('#quick-add, #long-section, #kontext-toggle, #addTaskButton').hide();
        loadAccount();
        return;
    }
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
            writeCache(view, response);
            const changed = JSON.stringify(response) !== JSON.stringify(cached);
            if (currentView === view && changed) {
                renderTable(response, view);
            }
        },
        error: function (xhr, status, error) {
            console.error('Error fetching data:', status, error);
        }
    });
    $('#addTaskButton').toggle(view === 'all');
    $('#quick-add').toggle(isDayView(view));
    $('#long-section').toggle(isDayView(view));
    $('#kontext-toggle').toggle(view === 'all');
    // Arbeit braucht weder Priorität noch Dauer
    const workForm = view === 'all' && allKontext === 'arbeit';
    $('#selectPriority, #inputDuration, #editSelectPriority, #editInputDuration').closest('[class*="col"]').toggle(!workForm);
    $('#selectPriority, #inputDuration, #editSelectPriority, #editInputDuration').prop('required', !workForm);
    $('#pickDueDate, #inputFrequency, #editPickDueDate, #editInputFrequency').closest('[class*="col"]')
        .css('flex', workForm ? '0 0 100%' : '')
        .css('max-width', workForm ? '100%' : '');
    $('#kontext-toggle button').each(function () {
        $(this).toggleClass('active', $(this).data('kontext') === allKontext);
    });
    $('#quickInput').attr('placeholder', view === 'work' ? 'ASAP: Outlook aufräumen, staffit' : 'aufräumen, einkaufen, post');
    $('#longInput').attr('placeholder', view === 'work' ? 'Langfristig: Diagramm bis fr, Zertifikat bis 15.12.' : 'Langfristig: Steuererklärung bis 31.7., Fahrrad');
    if (isDayView(view)) {
        loadLong();
    }
}

function loadTodayTable() { loadView('today'); }
function loadAllTable() { loadView('all'); }

function renderTable(items, view) {
    const $tableBody = $('#card-content > table > tbody');
    $tableBody.empty();
    clearSelection();

    if (items.length === 0) {
        $tableBody.append(`
            <tr>
                <td colspan="5" style="text-align: center;">Nix 🎉</td>
            </tr>
        `);
        return;
    }

    items.forEach(item => $tableBody.append(buildRow(item, view)));
    initSortable(view);
    updateBulkBar();
}

function buildRow(item, view) {
    const btn = (label, onclick, disabled = false) =>
        `<button ${disabled ? 'disabled' : ''} type="button" class="dropdown-item btn btn-sm btn-outline-success" onclick="${onclick}">${label}</button>`;

    const menu = isDayView(view)
        ? [
            btn('Erledigt', `runTaskAction('done', ['${item.id}'])`),
            btn('Nicht Heute', `runTaskAction('not-today', ['${item.id}'])`),
            btn('Morgen', `runTaskAction('tomorrow', ['${item.id}'])`),
            btn('Nächste Woche', `runTaskAction('next-week', ['${item.id}'])`),
        ]
        : [
            btn('Erledigt', `runTaskAction('done', ['${item.id}'])`),
            btn('Bearbeiten', `taskEdit('${item.id}')`),
            btn('Löschen', `startTaskDelete(['${item.id}'])`),
            btn('Morgen', `runTaskAction('tomorrow', ['${item.id}'])`),
            btn('Nächste Woche', `runTaskAction('next-week', ['${item.id}'])`),
        ];

    return `
        <tr data-id="${item.id}" data-name="${escapeHtml(item.name)}" data-long="${item.longTerm ? 'true' : 'false'}">
            ${isDayView(view) ? '<td class="drag-handle" style="width: 1%; cursor: grab; touch-action: none;"><i class="bi bi-grip-vertical text-muted"></i></td>' : ''}
            <td>${escapeHtml(item.name)}</td>
            <td class="text-muted" style="font-size: small; white-space: nowrap;">${item.deadline ? `<span class="text-danger">${relativeDays(daysUntil(item.deadline))}</span>` : getRelativeDate(item.dueDate)}</td>
            ${isDayView(view) || kontextFor(view) === 'arbeit' ? '' : `<td style="font-size: small;">${getPriorityIcon(item.priorityLevel.name)}</td>`}
            <td class="text-end" style="width: 1%;">
                <div class="dropdown">
                    <button class="btn tn-outline-success btn-sm dropdown-toggle" type="button" data-bs-toggle="dropdown" aria-expanded="false"></button>
                    <div class="dropdown-menu">
                        ${menu.join('\n')}
                    </div>
                </div>
            </td>
        </tr>
    `;
}

// ---------- Aktionen ----------

// Führt eine Aktion für eine oder mehrere Tasks aus und lädt danach die aktuelle Ansicht neu
function runTaskAction(action, taskIds) {
    const config = TASK_ACTIONS[action];
    if (!config || taskIds.length === 0) return;
    taskIds = taskIds.map(String);

    // In "Heute" verschwindet ein Task bei jeder Aktion, in "Alle" nur beim Löschen
    if (isDayView(currentView) || action === 'delete') {
        taskIds.forEach(id => $(`tr[data-id="${id}"]`).fadeOut(150, function () { $(this).remove(); }));
        [currentView, 'long'].forEach(view => {
            const remaining = (readCache(view) || []).filter(t => !taskIds.includes(String(t.id)));
            writeCache(view, remaining);
        });
        clearSelection();
    }

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

function startTaskDelete(taskIds) {
    const label = taskIds.length === 1
        ? `"${$(`tr[data-id="${taskIds[0]}"]`).data('name')}"`
        : `${taskIds.length} Aufgaben`;

    $('#toBeDeletedTaskName').text(label);
    $('#toBeDeletedTaskButton').off('click').on('click', function () {
        $('#deleteTaskModal').modal('hide');
        runTaskAction('delete', taskIds);
    });
    $('#deleteTaskModal').modal('show');
}

function taskEdit(taskId) {
    $.ajax({
        url: apiPrefix + `user/${$.cookie('user_id')}/task/${taskId}`,
        method: 'GET',
        dataType: 'json',
        success: function (item) {
            $('#editTaskId').val(item.id);
            $('#editInputTask').val(item.name);
            $('#editSelectPriority').val(item.priorityLevel.id);
            $('#editPickDueDate').val(item.dueDate);
            $('#editInputFrequency').val(item.rhythm);
            $('#editInputDuration').val(item.duration);
            $('#editTaskModal').modal('show');
        },
        error: function (xhr, status, error) {
            console.error('Error fetching task:', status, error);
        }
    });
}

function saveTaskEdit() {
    const taskId = $('#editTaskId').val();

    const task = {
        priorityLevel: { id: kontextFor('all') === 'arbeit' ? null : parseInt($('#editSelectPriority').val()) },
        name: $('#editInputTask').val(),
        duration: kontextFor('all') === 'arbeit' ? null : parseInt($('#editInputDuration').val()),
        dueDate: $('#editPickDueDate').val(),
        rhythm: $('#editInputFrequency').val().trim(),
        today: 0
    };

    $.ajax({
        url: apiPrefix + `user/${$.cookie('user_id')}/task/${taskId}`,
        method: 'PUT',
        contentType: 'application/json',
        data: JSON.stringify(task),
        success: function () {
            $('#editTaskModal').modal('hide');
            reloadCurrentView();
        },
        error: function (xhr, status, error) {
            console.error('Error updating task:', status, error);
        }
    });
}

function addTask() {
    name = $('#inputTask').val();
    priorityLevelId = $('#selectPriority').val();
    dueDate = $('#pickDueDate').val();
    frequency = $('#inputFrequency').val();
    duration = $('#inputDuration').val();

    const apiEndpoint = apiPrefix + `task`;

    task = {
        priority_level_id: kontextFor('all') === 'arbeit' ? null : priorityLevelId,
        user_id: $.cookie('user_id'),
        name: name,
        duration: kontextFor('all') === 'arbeit' ? null : duration,
        dueDate: dueDate,
        rhythm: frequency,
        today: 0,
        kontext: kontextFor('all')
    }

    $.ajax({
        url: apiEndpoint,
        method: 'POST',
        contentType: 'application/json',
        data: JSON.stringify(task), // Aufgabe als JSON-String senden
        success: function (data, textStatus, xhr) {
            $('#exampleModalCenter').modal('hide');
            if (xhr.status === 201) {
                emptyForm();
            }
            reloadCurrentView();
        },
        error: function (xhr, status, error) {
            console.error('Error adding task:', status, error);
        }
    });
}

function refreshToday() {
    const userId = $.cookie('user_id')
    const apiEndpoint = apiPrefix + `user/${userId}/tasks/today`;

    $.ajax({
        url: apiEndpoint,
        method: 'PATCH',
        contentType: 'application/json',
        success: function () {
            reloadCurrentView();
        },
        error: function (xhr, status, error) {
            console.error('Error refreshing today:', status, error);
        }
    });
}

// ---------- Reihenfolge per Drag & Drop ----------

let sortables = null;

function initSortable(view) {
    if (typeof Sortable === 'undefined') return;
    if (!sortables) {
        const common = { handle: '.drag-handle', animation: 150, onEnd: onDrop };
        sortables = [
            Sortable.create(document.querySelector('#card-content > table > tbody'), {
                ...common,
                group: { name: 'tasks', pull: true, put: true },
            }),
            // In die langfristige Liste dürfen nur langfristige To-dos zurück
            Sortable.create(document.getElementById('long-body'), {
                ...common,
                group: { name: 'tasks', pull: true, put: (to, from, dragEl) => dragEl.dataset.long === 'true' },
            }),
        ];
    }
    sortables.forEach(s => s.option('disabled', !isDayView(view)));
}

function onDrop(evt) {
    const fromKey = evt.from.id === 'long-body' ? 'long' : currentView;
    const toKey = evt.to.id === 'long-body' ? 'long' : currentView;
    if (fromKey === toKey && evt.oldIndex === evt.newIndex) return;

    const id = evt.item.getAttribute('data-id');
    const fromCache = readCache(fromKey) || [];
    const task = fromCache.find(t => String(t.id) === id);
    if (!task) return;

    const toCache = fromKey === toKey ? fromCache : (readCache(toKey) || []);
    const byId = Object.fromEntries(toCache.map(t => [String(t.id), t]));
    byId[id] = task;
    const ids = [...evt.to.querySelectorAll('tr[data-id]')].map(r => r.getAttribute('data-id'));
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
            writeCache('long', response);
            if (JSON.stringify(response) !== JSON.stringify(cached)) {
                renderLong(response);
            }
        },
        error: function (xhr, status, error) {
            console.error('Error fetching long-term tasks:', status, error);
        }
    });
}

function renderLong(items) {
    const $body = $('#long-body');
    $body.empty();
    if (items.length === 0) {
        $body.append('<tr><td colspan="4" class="text-muted small" style="text-align: center;">Nichts geplant</td></tr>');
        return;
    }
    items.forEach(item => $body.append(buildLongRow(item)));
    initSortable(currentView);
}

function buildLongRow(item) {
    const btn = (label, onclick) =>
        `<button type="button" class="dropdown-item btn btn-sm btn-outline-success" onclick="${onclick}">${label}</button>`;
    return `
        <tr data-id="${item.id}" data-name="${escapeHtml(item.name)}" data-long="true">
            <td class="drag-handle" style="width: 1%; cursor: grab; touch-action: none;"><i class="bi bi-grip-vertical text-muted"></i></td>
            <td class="text-muted">${escapeHtml(item.name)}</td>
            ${deadlineCell(item)}
            <td class="text-end" style="width: 1%;">
                <div class="dropdown">
                    <button class="btn btn-sm dropdown-toggle" type="button" data-bs-toggle="dropdown" aria-expanded="false"></button>
                    <div class="dropdown-menu dropdown-menu-end">
                        ${btn('Heute', `runTaskAction('to-today', ['${item.id}'])`)}
                        ${btn('Erledigt', `runTaskAction('done', ['${item.id}'])`)}
                        ${btn('Löschen', `startTaskDelete(['${item.id}'])`)}
                    </div>
                </div>
            </td>
        </tr>
    `;
}

// ---------- Sync zwischen Geräten ----------

// Nicht neu zeichnen, während ein Menü offen ist, gezogen wird oder auf der Konto-Seite
function safeRefresh() {
    if (currentView === 'account') return;
    if ($('.dropdown-menu.show').length || $('.sortable-chosen').length) return;
    reloadCurrentView();
}

// Sofort neu laden, wenn das Fenster wieder in den Vordergrund kommt
document.addEventListener('visibilitychange', function () {
    if (!document.hidden) safeRefresh();
});
window.addEventListener('focus', safeRefresh);

// Leichtes Polling, solange das Fenster sichtbar ist
setInterval(function () {
    if (!document.hidden) safeRefresh();
}, 60000);

// ---------- Konto ----------

$(document).on('click', '#account-link', function (event) {
    event.preventDefault();
    setView('account');
});

function showAccountMessage(text, ok) {
    $('#accountMessage').toggleClass('text-success', ok).toggleClass('text-danger', !ok).text(text);
}

function loadAccount() {
    $('#accountMessage').text('');
    $.ajax({
        url: apiPrefix + `user/${$.cookie('user_id')}/profile`,
        method: 'GET',
        dataType: 'json',
        success: function (p) {
            $('#dailyLimit').val(p.dailyLimit);
            $('#maxLimit').val(p.maxLimit);
            $('#budgetToday').text(p.budgetToday);
        },
        error: function () {
            showAccountMessage('Konto konnte nicht geladen werden.', false);
        }
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
        }),
        success: function (p) {
            $('#budgetToday').text(p.budgetToday);
            showAccountMessage('Gespeichert.', true);
        },
        error: function (xhr) {
            showAccountMessage((xhr.responseJSON && xhr.responseJSON.message) || 'Speichern fehlgeschlagen.', false);
        }
    });
}

// ---------- Deadlines ----------
// START DEADLINE
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
    const [y, m, d] = iso.split('-').map(Number);
    return Math.round((new Date(y, m - 1, d) - startOfToday()) / 86400000);
}

function relativeDays(days) {
    if (days === 0) return 'heute';
    if (days === 1) return 'morgen';
    if (days === -1) return 'gestern';
    return days > 1 ? `in ${days} Tagen` : `vor ${-days} Tagen`;
}

function deadlineCell(item) {
    if (!item.deadline) return '<td></td>';
    const days = daysUntil(item.deadline);
    return `<td class="${days <= 2 ? 'text-danger' : 'text-muted'} text-end" style="font-size: small; white-space: nowrap;">${relativeDays(days)}</td>`;
}
// END DEADLINE

// ---------- Schnelle Eingabe ----------

// Legt To-dos an, mehrere durch Komma getrennt. kind: 'today' (spontan) oder 'long' (langfristig)
function addQuick(kind, $input) {
    const names = $input.val().split(',').map(s => s.trim()).filter(Boolean);
    if (names.length === 0) return;
    $input.val('');

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

function quickAdd(event) {
    event.preventDefault();
    addQuick('today', $('#quickInput'));
}

function longAdd(event) {
    event.preventDefault();
    addQuick('long', $('#longInput'));
}

// ---------- Mehrfachauswahl ----------

function toggleSelection(taskId, checked) {
    if (checked) {
        selectedIds.add(taskId);
    } else {
        selectedIds.delete(taskId);
    }
    updateBulkBar();
}

function clearSelection() {
    selectedIds.clear();
    $('.task-select').prop('checked', false);
    updateBulkBar();
}

function bulkAction(action) {
    const ids = [...selectedIds];
    if (ids.length === 0) return;

    if (action === 'delete') {
        startTaskDelete(ids);
    } else {
        runTaskAction(action, ids);
    }
}

function updateBulkBar() {
    const count = selectedIds.size;
    const $bar = $('#bulk-bar');

    $bar.find('.bulk-btn').prop('disabled', count === 0);
    $('#bulk-count').text(count > 0 ? `${count} ausgewählt` : '');

    // Nur Aktionen zeigen, die zur aktuellen Ansicht passen
    $bar.find('[data-view]').each(function () {
        $(this).toggle($(this).data('view') === currentView);
    });
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

// Helper function to map priority level to an icon
function getPriorityIcon(priorityName) {
    switch (priorityName) {
        case 'ASAP':
            return '<i style="color: #c35140" class="bi bi-exclamation-circle-fill"></i>';
        case 'HIGH':
            return '<i style="color: #c35140" class="bi bi-circle-fill"></i>';
        case 'MEDIUM':
            return '<i style="color: #ffc833" class="bi bi-circle-fill"></i>';
        case 'LOW':
            return '<i style="color: #40c351" class="bi bi-circle-fill"></i>';
        default:
            return '<i style="color: grey" class="bi bi-circle-fill"></i>';
    }
}

function getRelativeDate(dateStr) {
    if (!dateStr) return '';
    try {
        const dueDate = new Date(dateStr); // Das Datum aus der übergebenen Zeichenkette erstellen
        const today = new Date();
        const delta = Math.floor((dueDate - today) / (1000 * 60 * 60 * 24)) + 1; // Differenz in Tagen

        if (delta === 0) {
            return "heute";
        } else if (delta === 1) {
            return "morgen";
        } else if (delta > 1) {
            return `in ${delta} Tagen`;
        } else if (delta === -1) {
            return "gestern";
        } else {
            return `vor ${-delta} Tagen`;
        }
    } catch (error) {
        return "Ungültiges Datumsformat. Bitte ein Datum im Format 'YYYY-MM-DD' übergeben.";
    }
}

function emptyForm() {
    $("#inputTask").val('');
    $("#selectPriority").val('4');
    $("#pickDueDate").val('');
    $("#inputFrequency").val('');
    $("#inputDuration").val('');
}

// Info-Badges (Bootstrap-Popover) aktivieren
$(function () {
    if (!window.bootstrap) return;
    document.querySelectorAll('[data-bs-toggle="popover"]').forEach(el => bootstrap.Popover.getOrCreateInstance(el));
});
