function loadTodayTable() {
    const apiEndpointToday = 'https://n6vigzrqtg.execute-api.eu-central-1.amazonaws.com/dev/user/867054409/tasks/today';
    
    $.ajax({
        url: apiEndpointToday,
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
                        <td><input class="form-check-input task-done" type="checkbox" data-id="${item.id}"></td>
                    </tr>
                `;
                $tableBody.append(row); // Append the row to the table body
            });
        },
        error: function (xhr, status, error) {
            console.error('Error fetching data:', status, error);
        }
    });
}

function loadAllTable() {
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
        },
        error: function (xhr, status, error) {
            console.error('Error fetching data:', status, error);
        }
    });
}

function taskDone(taskId) {
    $('#overlay').css('display', 'block');

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
                        $('#overlay').css('display', 'none');
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

// Helper function to map priority level to an icon
function getPriorityIcon(priorityName) {
    switch (priorityName) {
        case 'ASAP':
            return '❗️';
        case 'HIGH':
            return '🔴';
        case 'MEDIUM':
            return '🟡';
        case 'LOW':
            return '🟢';
        default:
            return '⚪️';
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
