var del = 1;
const Docker = require('dockerode');
const icingaapi = require('./libs/icingaapi')
var store = require('json-fs-store')('storage');
var winston = require('winston');

const dockersock = process.env.DOCKERSOCK;
const monUrl = process.env.MONITORING_API_URL;
const monAPIPort = process.env.MONITORING_API_PORT;
const monAPIUser = process.env.MONITORING_API_USER;
const monAPIPass = process.env.MONITORING_API_PASS;
const servername = process.env.DOCKERSERVERNAME;
const templatehost = process.env.TEMPLATEHOST;
const templateservice = process.env.TEMPLATESERVICE;
const hostgroup = process.env.HOSTGROUP;
const servicegroup = process.env.SERVICEGROUP
const defaultMonitoring = process.env.DEFAULT_MONITORING;
const debugnode = process.env.DEBUGNODE; //if you need debug



var icingaServer = new icingaapi(monUrl, monAPIPort, monAPIUser, monAPIPass); //create icingaapi object
var docker = new Docker({ socketPath: dockersock }); //create docker object

if (debugnode == "true") { //set logger to debug level
    var level = "debug";
} else {
    var level = "info";
}

var logger = new (winston.Logger)({ //define winston object
    "level": level,
    transports: [
        new (winston.transports.Console)()
    ]
})

logger.debug("D001:DEBUG on ++++++++++++++++++++++++++++++++++");
logger.debug("D002: Vars Info: ");
logger.debug("	DOCKERSOCK:  " + dockersock);
logger.debug("	MONITORING_API_URL:  " + monUrl);
logger.debug('	MONITORING_API_PORT:  ' + monAPIPort);
logger.debug('	MONITORING_API_USER:  ' + monAPIUser);
logger.debug('	MONITORING_API_PASS:  ' + monAPIPass);
logger.debug('	DOCKERSERVERNAME:  ' + servername);
logger.debug('	TEMPLATEHOST:  ' + templatehost);
logger.debug('	TEMPLATESERVICE:  ' + templateservice);
logger.debug('	HOSTGROUP:  ' + hostgroup);
logger.debug('	SERVICEGROUP:  ' + servicegroup);
logger.debug('	DEFAULT_MONITORING:  ' + defaultMonitoring);
logger.debug('	DEBUGNODE:  ' + debugnode);

var dockerCon = []; //arr to write docker container
var icingaCon = []; //arr to write container, that already exist on icinga2 server

if (del == 1) {
    //options for docker object
    var opts = {
        "all": true
        //  "all": true,
        // "filters": '{"label": ["monitoring=true"]}'
    };
} else {
    var opts = {
        //"all": true
        "all": true,
        "filters": '{"label": ["monitoring=true"]}'
    };
}

//get docker info
docker.info(function (err, data) {
    //search docker host in icinga2 server (check if this already exist);
    icingaServer.getHostFiltered({
        "filter": "host.name == server",
        "filter_vars": {
            "server": servername
        }
    }, function (err, result) {
        if (result == 0) {
            //write a custom host definition for icinga2 server
            icingaServer.createHostCustom(JSON.stringify({
                "templates": [templatehost],
                "attrs": {
                    "display_name": data.Name,
                    "vars.group": hostgroup,
                    "vars.Docker_version": data.ServerVersion,
                    "vars.DockerRootDir": data.DockerRootDir,
                    "vars.MemTotal": formatBytes(data.MemTotal, 2),
                    "vars.CPU": data.NCPU,
                    "vars.OS": data.OperatingSystem,
                    "vars.Kernel": data.KernelVersion
                }
            }), servername, function (err, result) {
                if (err) {
                    logger.error("ER01:" + err);
                } else {
                    icingaServer.getHostState(servername, function (err, result) {
                        if (err) {
                            logger.error("ER14:", err, " Docker host was not created");
                        } else {
                            logger.debug("D015: ", "Docker host object was created");
                            icingaServer.setHostState(servername, 0, "OK - Everything is going to be fine", function (err, data) {
                                if (err) {
                                    logger.error("ER13:" + JSON.stringify(err));
                                    logger.debug("E010:setHostState(0)(err): ", err);
                                } else {
                                    logger.info("I005:Docker Host: ", "running")
                                    logger.debug("D014:setHostState(0)(ok): ", data);
                                }
                            });
                        }
                    })
                }
            })
        } else {
            //set state "OK" to docker hosting
            icingaServer.setHostState(servername, 0, "OK - Everything is going to be fine", function (err, data) {
                if (err) {
                    logger.error("ER10:" + JSON.stringify(err));
                    logger.debug("E001:setHostState(0)(err): ", err);
                } else {
                    logger.info("I001:Docker Host: ", "running")
                    logger.debug("D002:setHostState(0)(ok): ", data);
                }
            });
        }
    })
})
//get a list of all container on the docker host
docker.listContainers(opts, function (err, containers) {
    var contArr = [];

    for (var i = 0; i < containers.length; i++) {
        var container = docker.getContainer(containers[i].Id);
        //write an array with all containers on docker host
        container.inspect(function (err, conData) {
	    var networks =  conData.NetworkSettings.Networks;
            // Take the first network as we can only handle one address per container
            var address = networks[Object.keys(networks)[0]].IPAddress;
            var containerData = {
                "id": conData.Id.slice(0, 12),
                "name": conData.Name.slice(1, conData.Name.length),
                "state": conData.State.Status,
                "pid": conData.State.Pid,
                "started": conData.State.StartedAt,
                "address": address
            };

            if (conData.Config.Labels.monitoring == null && defaultMonitoring != "false") {

                containerData.processes = null
                dockerCon.push(containerData)
            } else if (conData.Config.Labels != null && conData.Config.Labels.monitoring == "true") {
                containerData.processes = conData.Config.Labels.processes
                dockerCon.push(containerData)
            }

        })
    }
    //get all host objects of icinga server with filter "servername (system var)"
    icingaServer.getHostFiltered({
        "filter": "host.vars.server == server",
        "filter_vars": {
            "server": servername
        }
    }, function (err, iciObj) {
        if (err) {
            logger.error("ER02:" + err);
        } else {
            for (var i = 0; i < iciObj.length; i++) {
                icingaCon.push(iciObj[i]);
            }

            deleteDiffToDocker(dockerCon, icingaCon); //delete host objects in icinga2 if a container on docker host don't exist
            createDiffToDocker(dockerCon, icingaCon); //create host objects in icinga2 if found a docker container, that not already exist in icinga2
            for (var i = 0; i < dockerCon.length; i++) {
                setHostState(dockerCon[i]); //set state of host object in icinga for all containers
            }
        }
    })
})
//function to check state of a host object in icinga2
function setHostState(pCon) {
    let con = pCon;
    if (con.state == "running") {
        icingaServer.setHostState(con.id, 0, "OK - " + con.state + " ### PID:" + con.pid + " ### Started at:" + con.started + " ### on Host: " + servername, function (err, result) {
            if (err) {
                logger.error("ER11:" + JSON.stringify(err), "Container: ", con.name);
                logger.debug("E002:setHostState(0)(err): ", err);
            } else {
                logger.info("I002:Container:", con.id, ":", con.state);
                logger.debug("D003:setHostState(0)(ok): " + con.state, JSON.stringify(result));

                createSetServiceState(con); //check or crete a service object in icinga2
            }
        });
    } else {
        icingaServer.setHostState(con.id, 1, "ERROR - " + con.state + " ### PID:" + con.pid + " ### Started at:" + con.started + " ### on Host: " + servername, function (err, result) {
            if (err) {
                logger.error("ER12:" + JSON.stringify(err));
                logger.debug("E003:setHostState(1)(err): " + JSON.stringify(err));
            } else {
                logger.info("I003:Container:", con.id, ":", con.state);
                logger.debug("D004:Container:", con.id, ":", con.state)
            }
        });
    }
}

function search(nameKey, myArray) {
    for (var i = 0; i < myArray.length; i++) {
        if (myArray[i].name === nameKey) {
            return myArray[i];
        }
    }
}

function searchDocker(nameKey, myArray) {
    for (var i = 0; i < myArray.length; i++) {
        if (myArray[i].id === nameKey) {
            return myArray[i];
        }
    }
}
//function to check diff between icinga2 host objects and containers on docker host
function createDiffToDocker(dockerArr, monArr, pCallback) {
    var ic = [];
    var dk = [];
    for (var i = 0; i < monArr.length; i++) {
        ic.push(monArr[i].name);
    }
    for (var y = 0; y < dockerArr.length; y++) {
        dk.push(dockerArr[y].id);
    }

    var diff = dk.filter(x => ic.indexOf(x) == -1);
    if (diff.length > 0) {
        for (var x = 0; x < diff.length; x++) {
            (function (contoSearch) {
                var se = searchDocker(contoSearch, dockerArr);
                if (se !== undefined && se != null) {
                    icingaServer.createHost(templatehost, se.id, se.name, hostgroup, servername, se.address, function (err, result) {
                        if (err) {
                            logger.error("ER03:" + err);
                            logger.debug("E004:createHost: ID:", se.id, " Name: ", se.name);
                        } else {
                            logger.debug("D009:createHost: OK ID: ", se.id, " Name: ", se.name);
                            setHostState(se); //set host state in icinga2
                        }
                    });
                }
            })(diff[x])
        }

    }
}
//func to delete icinga2 host definitions if container doesn't exist (delete or move);
function deleteDiffToDocker(dockerArr, monArr) {
    var ic = [];
    var dk = [];
    for (var i = 0; i < monArr.length; i++) {
        ic.push(monArr[i].name);
    }
    for (var y = 0; y < dockerArr.length; y++) {
        dk.push(dockerArr[y].id);
    }

    var diff = ic.filter(x => dk.indexOf(x) == -1);

    if (diff.length > 0) {
        for (var x = 0; x < diff.length; x++) {
            icingaServer.deleteHost(diff[x], function (err, result) {
                if (err) {
                    logger.error("ER08" + err);
                    logger.debug("E009:deleteDiffToDocker: ", diff[x]);
                } else {
                    logger.debug("D008:deleteDiffToDocker:  success");
                }
            })
        }
    }
}
//func to check or create a icinga2 service (if you defined a service in labels)
function createSetServiceState(con) {
    if (con.processes != undefined) {
        var arrProc = JSON.parse(con.processes)
        var setState = function () {
            var container = docker.getContainer(con.id);
            container.top(con.id, function (err, condata) {
                if (con.processes != undefined) {
                    var container = docker.getContainer(con.id);
                    container.top(con.id, function (err, data) {
                        var conProc = data.Processes;
                        var monProc = JSON.parse(con.processes);
                        for (var i = 0; i < monProc.length; i++) {
                            (function (procFromMon) {
                                var searchIN = "" + conProc, substring = procFromMon;
                                if (searchIN.indexOf(substring) > -1) {
                                    icingaServer.setServiceState(procFromMon, con.id, 0, function (err, result) {
                                        if (err) {
                                            logger.error("ER04:" + err.toString());
                                            logger.debug("E005:setServiceState: ", err, " Servicename: ", procFromMon, " Container: ", con.id);
                                        } else {
                                            logger.debug("D005:setServiceState: successfull created", " Servicename: ", procFromMon, " Container: ", con.id)
                                        }
                                    })
                                } else {
                                    icingaServer.setServiceState(procFromMon, con.id, 2, function (err, result) {
                                        if (err) {
                                            logger.error("ER05:" + err);
                                            logger.debug("E006:setServiceState: ", err, "\n", " Servicename: ", procFromMon, " Container: ", con.id);
                                        } else {
                                            logger.debug("D006:setServiceState: successfull created", "\n", " Servicename: ", procFromMon, " Container: ", con.id)
                                        }
                                    })
                                }
                            })(monProc[i])
                        }

                    });
                }
            })
        }

        var createService = function () {
            if (arrProc.length > 0) {
                for (var i = 0; i < arrProc.length; i++) {
                    (function (procFromArr) {
                        icingaServer.createService(templateservice, con.id, procFromArr, procFromArr + " (" + con.name + ")", servicegroup, servername, function (err, result) {
                            if (err) {
                                logger.error("ER06:" + err);
                                logger.debug("E007:createService: ", procFromArr, " Container: ", con.id);
                            } else {
                                logger.debug("D007:createService: ", procFromArr + "success", " Container: ", con.id);
                                createSetServiceState(con); //callback to check created service
                            }
                        })
                    })(arrProc[i])
                }
            }
        }

        icingaServer.getService(con.id, arrProc[0], function (err, result) {
            if (err) {
                logger.error("ER07:" + JSON.stringify(err));
            } else {
                if (result.Statuscode == "404") {
                    logger.debug("E008:getService :", arrProc[0]);
                    createService(); //if service was not found (in icinga2), the create one
                } else {
                    setState(); //if service was found, check state of them
                }
            }
        })
    }
}

function showArrDiff(arr1, arr2) {
    var ar1 = [];
    var ar2 = [];
    for (var i = 0; i < arr1.length; i++) {
        ar1.push(arr1[i].id);
    }
    for (var y = 0; y < arr2.length; y++) {
        ar2.push(arr2[y].name);
    }

    let diff = ar1.filter(x => ar2.indexOf(x) == -1);
    return diff;
}

function formatBytes(bytes, decimals) {
    if (bytes == 0) return '0 Byte';
    var k = 1000; // or 1024 for binary
    var dm = decimals + 1 || 3;
    var sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    var i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}
