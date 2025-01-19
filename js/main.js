function loadTodayTable() {
    $('#loading').css('display', 'flex');
    $('#card-content').css('display', 'none');
    const apiEndpointToday = 'https://n6vigzrqtg.execute-api.eu-central-1.amazonaws.com/dev/user/867054409/tasks/today';
    
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
                            <td>${getRelativeDate(item.dueDate)}</td>
                            <td>${item.duration}m</td>
                            <td>${getPriorityIcon(item.priorityLevel.name)}</td>
                            <td>
                                <button type="button" class="btn btn-sm btn-outline-success bi bi-check task-done" data-id=${item.id}>
                                </button>
                            </td>
                        </tr>
                    `;
                    $tableBody.append(row); // Append the row to the table body
                });
            }
            $('#loading').css('display', 'none');
            $('#card-content').css('display', 'block');
        },
        error: function (xhr, status, error) {
            console.error('Error fetching data:', status, error);
        }
    });
}

function loadAllTable() {
    $('#loading').css('display', 'flex');
    $('#card-content').css('display', 'none');
    // All
    const apiEndpointAll = 'https://n6vigzrqtg.execute-api.eu-central-1.amazonaws.com/dev/user/867054409/tasks';
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
                        <td>${getRelativeDate(item.dueDate)}</td>
                        <td>${item.duration}m</td>
                        <td>${getPriorityIcon(item.priorityLevel.name)}</td>
                    </tr>
                `;
                $tableBody.append(row); // Append the row to the table body
            });
            $('#loading').css('display', 'none');
            $('#card-content').css('display', 'block');
        },
        error: function (xhr, status, error) {
            console.error('Error fetching data:', status, error);
        }
    });
}

function taskDone(taskId) {
    $('#loading').css('display', 'flex');
    $('#card-content').css('display', 'none');
    
    const apiEndpoint = `https://n6vigzrqtg.execute-api.eu-central-1.amazonaws.com/dev/task/${taskId}`;

    // Schritt 1: Hole die Aufgabe per GET
    $.ajax({
        url: apiEndpoint,
        method: 'GET',
        dataType: 'json',
        success: function (task) {
            // Schritt 2: Berechne das neue Fälligkeitsdatum
            const today = new Date();
            const rhythm = task.rhythm; // Rhythmus aus der API-Antwort
            const endDate = new Date(today.setDate(today.getDate() + rhythm));
            const stringDate = endDate.toISOString().split('T')[0]; // Format: YYYY-MM-DD

            // Schritt 3: Aktualisiere das Fälligkeitsdatum
            task.dueDate = stringDate;
            task.today = 0;

            // Schritt 4: Sende die aktualisierte Aufgabe per PUT zurück
            $.ajax({
                url: apiEndpoint,
                method: 'PUT',
                contentType: 'application/json',
                data: JSON.stringify(task), // Aufgabe als JSON-String senden
                success: function(data, textStatus, xhr) {
                    if (xhr.status === 202) {
                        loadTodayTable();
                    }
                },
                error: function (xhr, status, error) {
                    console.error('Error updating task:', status, error);
                }
            });
        },
        error: function (xhr, status, error) {
            console.error('Error fetching task:', status, error);
        }
    });
}

function addTask(priorityLevelId, name, duration, dueDate, frequency) {    
    const apiEndpoint = `https://n6vigzrqtg.execute-api.eu-central-1.amazonaws.com/dev/task`;

    task = {
        priority_level_id: priorityLevelId,
        user_id: 867054409,
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
        success: function(data, textStatus, xhr) {
            $('#exampleModalCenter').modal('hide');
            if (xhr.status === 201) {
                $("#inputTask").val('');
                $("#selectPriority").val('4');
                $("#pickDueDate").val('');
                $("#inputFrequency").val('');
                loadAllTable();
            }
        },
        error: function (xhr, status, error) {
            console.error('Error adding task:', status, error);
        }
    });
}

function refreshToday() {    
    const userId = 867054409
    const apiEndpoint = `https://n6vigzrqtg.execute-api.eu-central-1.amazonaws.com/dev/user/${userId}/tasks/today`;

    $.ajax({
        url: apiEndpoint,
        method: 'PATCH',
        contentType: 'application/json',
        success: function(data, textStatus, xhr) {
            if (xhr.status === 202) {
                loadTodayTable();
            }
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
