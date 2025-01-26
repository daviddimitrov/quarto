let apiPrefix = "https://n6vigzrqtg.execute-api.eu-central-1.amazonaws.com/dev/";

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
            $.cookie('user_id', response.id, { expires: 30 }),
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

function loadTodayTable() {
    console.log($.cookie('user_id'));
    startLoadingScreen();
    const apiEndpointToday = apiPrefix + 'user/' + $.cookie('user_id') + '/tasks/today';

    $.ajax({
        url: apiEndpointToday,
        method: 'GET',
        dataType: 'json',
        success: function (response) {
            const $tableBody = $('tbody');
            $tableBody.empty(); // Clear existing rows if any

            if (response.length === 0) {
                // Add a row with the "Nothing to do today." message
                const emptyRow = `
                    <tr>
                        <td colspan="5" style="text-align: center;">Nix 🎉</td>
                    </tr>
                `;
                $tableBody.append(emptyRow);
            } else {
                response.forEach(item => {
                    // Build a new row
                    const row = `
                        <tr>
                            <td>${item.name}</td>
                            <td style="font-size: small;">${getRelativeDate(item.dueDate)}</td>
                            <td style="font-size: small;">${getPriorityIcon(item.priorityLevel.name)}</td>
                            <td>
                                <div class="dropdown">
                                    <button class="btn tn-outline-success btn-sm dropdown-toggle" type="button" data-bs-toggle="dropdown" aria-expanded="false">
                                        
                                    </button>
                                    <div class="dropdown-menu" aria-labelledby="dropdownMenu">
                                        <button type="button" class="dropdown-item btn btn-sm btn-outline-success" onclick="taskDone(${item.id});">Erledigt</button>
                                        <button type="button" class="dropdown-item btn btn-sm btn-outline-success" onclick="taskNotToday(${item.id});">Nicht Heute</button>
                                    </div>
                                </div>
                            </td>
                        </tr>
                    `;
                    $tableBody.append(row); // Append the row to the table body
                });
            }
            stopLoadingScreen();
        },
        error: function (xhr, status, error) {
            console.error('Error fetching data:', status, error);
        }
    });
    $('#addTaskButton').hide();
}

function loadAllTable() {
    startLoadingScreen();
    // All
    const apiEndpointAll = apiPrefix + 'user/' + $.cookie('user_id') + '/tasks';
    $.ajax({
        url: apiEndpointAll,
        method: 'GET',
        dataType: 'json',
        success: function (response) {
            const $tableBody = $('tbody');
            $tableBody.empty(); // Clear existing rows if any

            response.forEach(item => {
                // Build a new row
                const row = `
                    <tr>
                        <td>${item.name}</td>
                        <td style="font-size: small;">${getRelativeDate(item.dueDate)}</td>
                        <td style="font-size: small;">${getPriorityIcon(item.priorityLevel.name)}</td>
                        <td>
                            <div class="dropdown">
                                <button class="btn tn-outline-success btn-sm dropdown-toggle" type="button" data-bs-toggle="dropdown" aria-expanded="false">
                                    
                                </button>
                                <div class="dropdown-menu" aria-labelledby="dropdownMenu">
                                    <button type="button" class="dropdown-item btn btn-sm btn-outline-success" onclick="taskDone(${item.id});">Erledigt</button>
                                    <button disabled type="button" class="dropdown-item btn btn-sm btn-outline-success" onclick="taskEdit(${item.id});">Bearbeiten</button>
                                    <button type="button" class="dropdown-item btn btn-sm btn-outline-success" onclick="startTaskDelete('${item.name}', ${item.id});">Löschen</button>
                                </div>
                            </div>
                                                    </td>
                    </tr>
                `;
                $tableBody.append(row); // Append the row to the table body
            });
            stopLoadingScreen();
        },
        error: function (xhr, status, error) {
            console.error('Error fetching data:', status, error);
        }
    });

    $('#addTaskButton').show();
}

function taskDone(taskId) {
    startLoadingScreen();

    const apiEndpoint = apiPrefix + `task/${taskId}/done`;

    $.ajax({
        url: apiEndpoint,
        method: 'PATCH',
        contentType: 'application/json',
        success: function (data, textStatus, xhr) {
            if (xhr.status === 202) {
                loadTodayTable();
            }
            stopLoadingScreen();
        },
        error: function (xhr, status, error) {
            console.error('Error adding task:', status, error);
        }
    });
}

function startTaskDelete(task, taskId) {
    $('#toBeDeletedTaskName').text(task);
    $("#toBeDeletedTaskButton").attr("onclick", "taskDelete(" + taskId + ")");
    $('#deleteTaskModal').modal('show');
}

function taskNotToday(taskId) {
    startLoadingScreen();

    const apiEndpoint = apiPrefix + `task/${taskId}/today`;

    $.ajax({
        url: apiEndpoint,
        method: 'PATCH',
        contentType: 'application/json',
        success: function (data, textStatus, xhr) {
            if (xhr.status === 202) {
                loadTodayTable();
            }
            stopLoadingScreen();
        },
        error: function (xhr, status, error) {
            console.error('Error adding task:', status, error);
        }
    });
}

function taskDelete(taskId) {
    startLoadingScreen();

    $('#deleteTaskModal').modal('hide');

    const apiEndpoint = apiPrefix + `task/${taskId}`;

    $.ajax({
        url: apiEndpoint,
        method: 'DELETE',
        contentType: 'application/json',
        success: function (data, textStatus, xhr) {
            if (xhr.status === 202) {
                loadAllTable();
            }
            stopLoadingScreen();
        },
        error: function (xhr, status, error) {
            console.error('Error adding task:', status, error);
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
            loadAllTable()
            stopLoadingScreen();
        },
        error: function (xhr, status, error) {
            console.error('Error adding task:', status, error);
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
        success: function (data, textStatus, xhr) {
            if (xhr.status === 202) {
                loadTodayTable();
            }
            stopLoadingScreen();
        },
        error: function (xhr, status, error) {
            console.error('Error adding task:', status, error);
        }
    });
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