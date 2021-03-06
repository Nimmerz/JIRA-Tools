var app = angular.module('jiraworkload', ['chart.js']);

// This only works if you
// * install
// https://chrome.google.com/webstore/detail/allow-control-allow-origi/nlfbmbojpeacfghkpbjhddihlkkiljbi?hl=en
// * enable it
// * configure it to intercept https://<yourJiraRoot>/rest/api/*
app.config(function($httpProvider) {
    $httpProvider.defaults.useXDomain = true;
});

app.controller('MainCtrl', function($window, $http, $q) {
    document.title = "Jira Workload";

    vm = this;
    // Your Jira server's domain like "yourCompany.atlassian.net" or
    // "jira.yourCompany.local".  "https://" is assumed and added by
    // the code when building a request.
    vm.domain = ""

    // Your "active tickets" filter which has JQL like
    //   "sprint in openSprints()"
    vm.queryText = "";

    // Your Jira user ID and password (optionaly cached in local storage)
    vm.userId = "";
    vm.password = "";
    
    var storageKey = "jiraWorkload";

    var domain = localStorage.getItem(storageKey+".Domain");
    if (domain != null) {
        vm.domain = domain;
    }

    vm.queryTypes = [ "filter", "epic", "JQL", "sprint" ];
    vm.queryType = "filter";

    var queryText = localStorage.getItem(storageKey+".Query");
    if (queryText != null) {
        vm.queryText = queryText;
    }

    // FUTURE - save these in local storage?
    // Default estimate for unestimated tickets.  Better than 0 but
    // not really experience-based.
    vm.defaultEstimateHours = 8;

    // Available hours per day (per developer) after meetings,
    // unscheduled maintenance, etc.
    vm.availableHours = 5;

    // Number of days remaining to finish work
    vm.daysRemaining = 1;

    // Interaction with the chart is by index.  We display the
    // assignee display names (e.g., "Mickey Mouse") and assigned
    // hours.
    vm.assigneeNames = [];
    vm.workHours = [];

    // In the click handler, we get the index but want to be able to
    // look up the Jira username/ID (e.g., "mmouse") so we build an
    // array of IDs in the same order as we populate the chart data.
    var assigneeIds = [];
    
    var credential = localStorage.getItem(storageKey+".Cred");
    if (credential != null) {
        var parts = atob(credential).split(":");
        vm.userId = parts[0];
        vm.password = parts[1]
        // If we found credentials, it's because the user wanted last time
        // to remember them so set remember true now, too.
        vm.remember = true;
    }

    vm.submit = function() {
        vm.apiUrl = "https://" + vm.domain + "/rest/api/2/";

        credential = btoa(vm.userId + ":" + vm.password);
        
        if (vm.remember) {
            console.log("Setting local storage");
            localStorage.setItem(storageKey+".Domain", vm.domain);
            localStorage.setItem(storageKey+".Query", vm.queryText);
            localStorage.setItem(storageKey+".Cred", credential);
        }
        else {
            console.log("Clearing local storage");
            localStorage.removeItem(storageKey+".Domain");
            localStorage.removeItem(storageKey+".Query");
            localStorage.removeItem(storageKey+".Cred");
        }
        
        // Clear any data from previous submissions
        vm.assigneeNames = [];
        vm.workHours = [];
        assigneeIds = [];
        
        vm.query;
        switch (vm.queryType) {
        case "filter":
            // TODO - validate - we expect an integer
            vm.query = "jql=filter=" + vm.queryText;
            break;
        case "epic":
            vm.query = 'jql="Epic Link" = ' + vm.queryText;
            break;
        case "sprint":
            // TODO - validate - we expect an integer
            vm.query = "jql=sprint = " + vm.queryText;
            break;
        case "JQL":
            vm.query = "jql=" + vm.queryText;
            break;
        }
        
        getTickets(vm.query)
            .then(function successCallback(tickets) {
                var estimates = tickets.map(estimateFromTicket);
                                
                // A hash indexed by display name.  Each element
                // summarizes the work for that assignee.
                var workByAssignee = {};

                angular.forEach(estimates, function(e, index) {
                    if (!workByAssignee.hasOwnProperty(e.assigneeName)) {
                        workByAssignee[e.assigneeName] = {
                            hours: 0,
                            tickets: 0,
                            id: e.assigneeId
                        };
                    }
                    workByAssignee[e.assigneeName].hours += e.hours;
                    workByAssignee[e.assigneeName].tickets++;
                });

                // We want the bars in alphabetical order
                var sortedNames = Object.keys(workByAssignee).sort();
                // "Name" label will include ticket count.
                vm.assigneeNames = sortedNames.map(
                    function(k) { return k +
                                  " (" + workByAssignee[k].tickets + ")"; });
                // The height of the bar is hours.
                vm.workHours = sortedNames.map(
                    function(k) { return workByAssignee[k].hours; });
                // Keep track of IDs in the same order so we can
                // process clicks.
                assigneeIds = sortedNames.map(
                    function(k) { return workByAssignee[k].id; });

                
                // Each person can only work so many hours a day.
                // Zero means "don't show capacity and overwork."
                var capacity = vm.availableHours * vm.daysRemaining;
                
                if (capacity == 0) {
                    vm.message = "";
                }
                else {
                    vm.message = "Work capacity is " +
                        capacity + " hours per person.";
                    
                    // How many are overworked?
                    var atRisk = Object.keys(workByAssignee)
                        .filter(key => workByAssignee[key].hours > capacity)
                        .length;

                    if (atRisk) {
                        vm.message += "  " + atRisk +
                            (atRisk == 1 ? " is" : " are ") +
                            " at risk.";
                    }
                }
            }, function errorCallback(response) {
                console.log(response);
            });
        
    };

    vm.onChartClick = function(points, evt) {
        // The base URL: matches filter for the chart
        // AND limited by assignee
        var url = "https://" + vm.domain + "/issues/"
            + "?" + vm.query
            + " AND assignee";

        // Get the bar index
        var index = points[0]._index;
        // Look up the ID
        var id = assigneeIds[index];
        // Add the rest of the assignee clause
        if (id == "unassigned") {
            url += " is empty";
        } else {
            url += "="+id;
        }
        
        $window.open(url);
    }

    var estimateFromTicket = function(ticket) {
        var assignee = getAssignee(ticket);
        return {
            assigneeId : assignee.id,
            assigneeName : assignee.name,
            hours : getRemainingHours(ticket)
        };
    }
        
    var getAssignee = function(ticket) {
        // If undefined, null, or empty, return Unassigned
        if (!ticket.fields.assignee) {
            return {
                name: "Unassigned",
                id: "unassigned"
            };
        }
        else {
            return {
                name: ticket.fields.assignee.displayName,
                id: ticket.fields.assignee.name
            };
        }
    };

    var getRemainingHours = function(ticket) {
        if (ticket.fields.timeestimate == null) {
            // If there is no estimate at all, default
            if (!ticket.fields.timeoriginalestimate) {
                return vm.defaultEstimateHours;
            }
            // There is no remaining estimate, but there is a current
            // estimate, scale it from seconds to hours
            else {
                return ticket.fields.timeoriginalestimate / 3600;
            }
        }
        else {
            // There is a remaining estimate, scale it from seconds to
            // hours.
            return ticket.fields.timeestimate / 3600;
        }
    };

    // Returns a promise.  When that promise is satisfied, the data
    // passed back a list of tickets matching the Jira filter.
    var getTickets = function(query){
        var deferred = $q.defer();

        var url = "https://" + vm.domain + "/rest/api/2/";
        url += "search?" + query;
        url += "&maxResults=1000";
        
        $http({
            url: url,
            method: "GET",
            headers: { "Authorization": "Basic " + credential }
        })
            // FIXME - handle paged data.  We're not done if
            // data.startAt + data..maxResults < data.total
            .then(function successCallback(response) {
                deferred.resolve(response.data.issues);
            }, function errorCallback(response) {
                // CORS is handled by the client but we want to pass
                // something back to the caller.
                if (response.status == 0 && response.statusText == "") {
                    response.status = 403;
                    response.statusText =
                        "Getting recent ticket data failed in a way" +
                        " that suggests a CORS issue.  See the README" +
                        " for notes about installing and configuring" +
                        " the Allow-Control-Allow-Origin plugin.";
                    alert(response.statusText);
                }
                deferred.reject(response);
            });

        return deferred.promise;
    };
});
