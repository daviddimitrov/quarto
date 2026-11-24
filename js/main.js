let apiPrefix = "https://vs7ubni3p3.execute-api.eu-central-1.amazonaws.com/";

// Aktuelle Ansicht: 'today' oder 'all'
let currentView = 'today';

// Ausgewählte Task-IDs für Mehrfachbearbeitung
const selectedIds = new Set();

// Alle Aktionen an einer Stelle, für Einzel- und Mehrfachbearbeitung
const TASK_ACTIONS = {
    'done':      { method: 'PATCH',  path: id => `user/${$.cookie('user_id')}/task/${id}/done` },
    'not-today': { method: 'PATCH',  path: id => `user/${$.cookie('user_id')}/task/${id}/today` },
    'tomorrow':  { method: 'PATCH',  path: id => `user/${$.cookie('user_id')}/task/${id}/tomorrow` },
    'next-week': { method: 'PATCH',  path: id => `user/${$.cookie('user_id')}/task/${id}/next-week` },
    'delete':    { method: 'DELETE', path: id => `user/${$.cookie('user_id')}/task/${id}` },
};

function checkAuth() {
    if (typeof $.cookie('user_id') == 'undefined') {
        window.location.href = 'https://daviddimitrov.github.io/quarto/login.html';
    }
}

function login() {
    userName = $('#loginName').val();
    const apiEndpointAll = apiPrefix + 'user?user_name=' + userName;
    $.ajax({
        url: apiEndpointAll,
        method: 'GET',
        dataType: 'json',
        success: function (response) {
            $.cookie('user_id', response.id, { expires: 30 });
            window.location.href = 'https://daviddimitrov.github.io/quarto/';
        },
        error: function (xhr, status, error) {
            console.error('Error fetching data:', status, error);
        }
    });
}

function logout() {
    $.removeCookie('user_id'); // successfully deleted
    window.location.href = 'https://daviddimitrov.github.io/quarto/login.html';
}

// ---------- Ansichten ----------

function setView(view) {
    currentView = view;
    $('.nav-link').removeClass('active');
    $(view === 'all' ? '#all-link' : '#today-link').addClass('active');
    $('.table-header').text(view === 'all' ? 'Alle Aufgaben' : 'Heutige Aufgaben');
    // Ansicht in der URL merken, damit auch ein Browser-Reload auf "Alle" bleibt
    history.replaceState(null, '', view === 'all' ? '#alle' : '#heute');
    reloadCurrentView();
}

function reloadCurrentView() {
    loadView(currentView);
}

// ---------- Cache (Optimistic UI) ----------

function cacheKey(view) {
    return `quarto_${view}_${$.cookie('user_id')}`;
}

function readCache(view) {
    try { return JSON.parse(localStorage.getItem(cacheKey(view))); } catch (e) { return null; }
}

function writeCache(view, items) {
    try { localStorage.setItem(cacheKey(view), JSON.stringify(items)); } catch (e) {}
}

// Zeigt sofort den Cache und lädt im Hintergrund den aktuellen Stand
function loadView(view) {
    const cached = readCache(view);
    if (cached) {
        renderTable(cached, view);
        stopLoadingScreen();
    } else {
        startLoadingScreen();
    }

    const path = view === 'all' ? '/tasks' : '/tasks/today';
    $.ajax({
        url: apiPrefix + 'user/' + $.cookie('user_id') + path,
        method: 'GET',
        dataType: 'json',
        success: function (response) {
            writeCache(view, response);
            const changed = JSON.stringify(response) !== JSON.stringify(cached);
            if (currentView === view && changed) {
                renderTable(response, view);
            }
            stopLoadingScreen();
        },
        error: function (xhr, status, error) {
            console.error('Error fetching data:', status, error);
            stopLoadingScreen();
        }
    });
    $('#addTaskButton').toggle(view === 'all');
}

function loadTodayTable() { loadView('today'); }
function loadAllTable() { loadView('all'); }

function renderTable(items, view) {
    const $tableBody = $('tbody');
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
    updateBulkBar();
}

function buildRow(item, view) {
    const btn = (label, onclick, disabled = false) =>
        `<button ${disabled ? 'disabled' : ''} type="button" class="dropdown-item btn btn-sm btn-outline-success" onclick="${onclick}">${label}</button>`;

    const menu = view === 'today'
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
        <tr data-id="${item.id}" data-name="${escapeHtml(item.name)}">
            <td>${escapeHtml(item.name)}</td>
            <td style="font-size: small;">${getRelativeDate(item.dueDate)}</td>
            <td style="font-size: small;">${getPriorityIcon(item.priorityLevel.name)}</td>
            <td>
                <div class="dropdown">
                    <button class="btn tn-outline-success btn-sm dropdown-toggle" type="button" data-bs-toggle="dropdown" aria-expanded="false"></button>
                    <div class="dropdown-menu">
                        ${menu.join('\n')}
                    </div>
                </div>
            </td>
            <td class="text-end pe-3" style="width: 1%;">
                <div class="d-flex align-items-center justify-content-end" style="height: 35px;">
                    <input type="checkbox" class="form-check-input m-0 task-select" value="${item.id}">
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
    if (currentView === 'today' || action === 'delete') {
        taskIds.forEach(id => $(`tr[data-id="${id}"]`).fadeOut(150, function () { $(this).remove(); }));
        const remaining = (readCache(currentView) || []).filter(t => !taskIds.includes(String(t.id)));
        writeCache(currentView, remaining);
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
    startLoadingScreen();
    const taskId = $('#editTaskId').val();

    const task = {
        priorityLevel: { id: parseInt($('#editSelectPriority').val()) },
        name: $('#editInputTask').val(),
        duration: parseInt($('#editInputDuration').val()),
        dueDate: $('#editPickDueDate').val(),
        rhythm: parseInt($('#editInputFrequency').val()),
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
            stopLoadingScreen();
        }
    });
}

function addTask() {
    startLoadingScreen();
    name = $('#inputTask').val();
    priorityLevelId = $('#selectPriority').val();
    dueDate = $('#pickDueDate').val();
    frequency = $('#inputFrequency').val();
    duration = $('#inputDuration').val();

    const apiEndpoint = apiPrefix + `task`;

    task = {
        priority_level_id: priorityLevelId,
        user_id: $.cookie('user_id'),
        name: name,
        duration: duration,
        dueDate: dueDate,
        rhythm: frequency,
        today: 0
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
            stopLoadingScreen();
        }
    });
}

function refreshToday() {
    startLoadingScreen();
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
            stopLoadingScreen();
        }
    });
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

function startLoadingScreen() {
    $('#loading').css('display', 'flex');
    $('#card-content').css('display', 'none');
}

function stopLoadingScreen() {
    $('#loading').css('display', 'none');
    $('#card-content').css('display', 'block');
}

function emptyForm() {
    $("#inputTask").val('');
    $("#selectPriority").val('4');
    $("#pickDueDate").val('');
    $("#inputFrequency").val('');
    $("#inputDuration").val('');
}
