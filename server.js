const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = {};
const INSPECTION_MS = 15000;
const INSPECTION_DNF_MS = 17000;

function generateWCAScramble() {
    const axes = { X: ["R", "L"], Y: ["U", "D"], Z: ["F", "B"] };
    const sfx = ["", "'", "2"];
    const keys = Object.keys(axes);
    let out = [];
    let last = null;
    for (let i = 0; i < 20; i++) {
        let ax;
        do {
            ax = keys[Math.floor(Math.random() * keys.length)];
        } while (ax === last);
        last = ax;
        out.push(axes[ax][Math.floor(Math.random() * 2)] + sfx[Math.floor(Math.random() * 3)]);
    }
    return out.join(" ");
}

function createRoom(hostId) {
    return {
        hostId,
        scrambles: {},
        names: {},
        solves: {},
        raceEnabled: {},
        round: createRoundState(),
    };
}

function createRoundState() {
    return {
        phase: "idle",
        scramble: null,
        inspectionStartAt: null,
        inspectionPenaltyAt: null,
        inspectionDnfAt: null,
        ready: {},
        finishes: {},
        finishOrder: 0,
        firstFinisherId: null,
        rankings: null,
        penaltyTimer: null,
        dnfTimer: null,
    };
}

function getActiveRoomsSummary() {
    const out = [];
    const adapterRooms = io.sockets.adapter.rooms;

    for (const roomId of Object.keys(rooms)) {
        const members = adapterRooms.get(roomId);
        if (!members || members.size === 0) {
            delete rooms[roomId];
            continue;
        }
        const names = rooms[roomId].names || {};
        const users = [];
        for (const sid of members) {
            users.push(names[sid] || "Anonymous");
        }
        out.push({ roomId, userCount: members.size, users: users.sort((a, b) => a.localeCompare(b)) });
    }

    out.sort((a, b) => b.userCount - a.userCount || a.roomId.localeCompare(b.roomId));
    return out;
}

function broadcastRoomsChanged() {
    io.emit("roomsChanged", { rooms: getActiveRoomsSummary() });
}

function calcAoN(arr, n) {
    if (!Array.isArray(arr) || arr.length < n) return null;

    const seg = arr.slice(-n);
    const indexed = seg.map((t, i) => ({ t, i }));
    indexed.sort((a, b) => (a.t !== b.t ? a.t - b.t : a.i - b.i));
    const middle = indexed.slice(1, -1).map((x) => x.t);
    if (middle.some((v) => !Number.isFinite(v))) return Infinity;

    const sum = middle.reduce((a, b) => a + b, 0);
    return +(sum / middle.length).toFixed(2);
}

function getRaceParticipantIds(room, roomId) {
    const members = io.sockets.adapter.rooms.get(roomId);
    if (!members) return [];
    const ids = [];
    for (const sid of members) {
        if (room.raceEnabled[sid]) ids.push(sid);
    }
    return ids;
}

function canToggleRaceMode(room) {
    const phase = room.round.phase;
    return phase === "idle" || phase === "results";
}

function clearRoundTimers(room) {
    if (room.round.penaltyTimer) {
        clearTimeout(room.round.penaltyTimer);
        room.round.penaltyTimer = null;
    }
    if (room.round.dnfTimer) {
        clearTimeout(room.round.dnfTimer);
        room.round.dnfTimer = null;
    }
}

function isRaceSolvingPhase(phase) {
    return phase === "solving";
}

function serializeFinishes(finishes) {
    const out = {};
    for (const [sid, f] of Object.entries(finishes || {})) {
        out[sid] = {
            time: f.time === Infinity ? null : f.time,
            finishOrder: f.finishOrder,
            done: !!f.done,
            started: !!f.startedAt,
            startPenalty: f.startPenalty || 0,
        };
    }
    return out;
}

function buildRaceState(room) {
    return {
        hostId: room.hostId,
        raceEnabled: { ...room.raceEnabled },
        round: {
            phase: room.round.phase,
            scramble: room.round.scramble,
            inspectionStartAt: room.round.inspectionStartAt,
            inspectionPenaltyAt: room.round.inspectionPenaltyAt,
            inspectionDnfAt: room.round.inspectionDnfAt,
            ready: { ...room.round.ready },
            finishes: serializeFinishes(room.round.finishes),
            firstFinisherId: room.round.firstFinisherId,
            rankings: room.round.rankings,
        },
    };
}

function broadcastRaceState(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    io.to(roomId).emit("raceState", buildRaceState(room));
}

function transferHost(room, roomId) {
    const members = io.sockets.adapter.rooms.get(roomId);
    if (!members || members.size === 0) return;
    if (members.has(room.hostId)) return;
    room.hostId = members.values().next().value;
}

function allRaceParticipantsReady(room, roomId) {
    const ids = getRaceParticipantIds(room, roomId);
    if (ids.length === 0) return false;
    return ids.every((sid) => room.round.ready[sid]);
}

function startInspection(room, roomId) {
    clearRoundTimers(room);
    const now = Date.now();
    room.round.phase = "solving";
    room.round.inspectionStartAt = now;
    room.round.inspectionPenaltyAt = now + INSPECTION_MS;
    room.round.inspectionDnfAt = now + INSPECTION_DNF_MS;
    room.round.rankings = null;

    broadcastRaceState(roomId);

    room.round.penaltyTimer = setTimeout(() => {
        if (!rooms[roomId] || !isRaceSolvingPhase(rooms[roomId].round.phase)) return;
        io.to(roomId).emit("raceInspectionPenalty", {
            inspectionPenaltyAt: rooms[roomId].round.inspectionPenaltyAt,
            inspectionDnfAt: rooms[roomId].round.inspectionDnfAt,
        });
        broadcastRaceState(roomId);
    }, INSPECTION_MS);

    room.round.dnfTimer = setTimeout(() => {
        if (!rooms[roomId] || !isRaceSolvingPhase(rooms[roomId].round.phase)) return;
        dnfNonStarters(rooms[roomId], roomId);
        io.to(roomId).emit("raceInspectionEnded", {});
        broadcastRaceState(roomId);
    }, INSPECTION_DNF_MS);
}

function dnfNonStarters(room, roomId) {
    const ids = getRaceParticipantIds(room, roomId);
    for (const sid of ids) {
        const f = room.round.finishes[sid];
        if (!f || f.done) continue;
        if (!f.startedAt) {
            recordRaceFinish(room, roomId, sid, Infinity);
        }
    }
}

function raceStartPenalty(room, startedAt) {
    if (!startedAt || !room.round.inspectionPenaltyAt) return 0;
    return startedAt >= room.round.inspectionPenaltyAt ? 2 : 0;
}

function ensureRaceStarted(room, socketId, solveSeconds) {
    const f = room.round.finishes[socketId];
    if (!f || f.startedAt) return;

    const now = Date.now();
    if (now >= room.round.inspectionDnfAt) return;

    let startedAt = now;
    if (Number.isFinite(solveSeconds) && solveSeconds >= 0) {
        startedAt = now - solveSeconds * 1000;
        if (room.round.inspectionStartAt && startedAt < room.round.inspectionStartAt) {
            startedAt = room.round.inspectionStartAt;
        }
    }

    f.startedAt = startedAt;
    f.startPenalty = raceStartPenalty(room, startedAt);
}

function computeRankings(room, roomId) {
    const ids = getRaceParticipantIds(room, roomId);
    const entries = ids.map((sid) => {
        const f = room.round.finishes[sid];
        const time = f && f.done ? f.time : Infinity;
        const order = f && f.finishOrder ? f.finishOrder : 9999;
        return {
            id: sid,
            name: room.names[sid] || "Anonymous",
            time,
            finishOrder: order,
        };
    });

    entries.sort((a, b) => {
        const aDnf = !Number.isFinite(a.time);
        const bDnf = !Number.isFinite(b.time);
        if (aDnf !== bDnf) return aDnf ? 1 : -1;
        if (a.time !== b.time) return a.time - b.time;
        return a.finishOrder - b.finishOrder;
    });

    return entries.map((e, i) => ({
        place: i + 1,
        id: e.id,
        name: e.name,
        time: e.time === Infinity ? null : e.time,
    }));
}

function finishRoundToResults(room, roomId) {
    clearRoundTimers(room);
    room.round.phase = "results";
    room.round.rankings = computeRankings(room, roomId);
    broadcastRaceState(roomId);
    io.to(roomId).emit("roundResults", { rankings: room.round.rankings });
}

function checkAllRaceFinished(room, roomId) {
    const ids = getRaceParticipantIds(room, roomId);
    if (ids.length === 0) return;
    const allDone = ids.every((sid) => room.round.finishes[sid] && room.round.finishes[sid].done);
    if (allDone) finishRoundToResults(room, roomId);
}

function emitRaceFinisher(room, roomId, socketId) {
    const f = room.round.finishes[socketId];
    if (!f || !f.done) return;
    const time = f.time === Infinity ? null : f.time;
    io.to(roomId).emit("raceFinisher", {
        id: socketId,
        name: room.names[socketId] || "Anonymous",
        time,
        isFirst: room.round.firstFinisherId === socketId,
    });
}

function recordRaceFinish(room, roomId, socketId, time) {
    const f = room.round.finishes[socketId];
    if (!f) return;

    f.startPenalty = raceStartPenalty(room, f.startedAt);
    let finalTime = time;
    if (Number.isFinite(finalTime) && f.startPenalty) {
        finalTime = +(finalTime + f.startPenalty).toFixed(2);
    }

    if (!f.done) {
        if (!f.finishOrder) {
            room.round.finishOrder += 1;
            f.finishOrder = room.round.finishOrder;
        }
        f.time = finalTime;
        f.done = true;
        if (!room.round.firstFinisherId) {
            room.round.firstFinisherId = socketId;
        }
    } else {
        f.time = finalTime;
    }

    emitRaceFinisher(room, roomId, socketId);
    checkAllRaceFinished(room, roomId);
    broadcastRaceState(roomId);
}

function beginNextRound(room, roomId) {
    clearRoundTimers(room);
    const participants = getRaceParticipantIds(room, roomId);
    if (participants.length === 0) return;
    room.round = createRoundState();
    room.round.phase = "ready";
    room.round.scramble = generateWCAScramble();
    for (const sid of participants) {
        room.round.ready[sid] = false;
        room.round.finishes[sid] = {
            time: null,
            finishOrder: 0,
            done: false,
            startedAt: null,
            startPenalty: 0,
        };
    }
    broadcastRaceState(roomId);
}

function getInitPayload(room) {
    return {
        scrambles: room.scrambles,
        names: room.names,
        solves: room.solves,
        race: buildRaceState(room),
    };
}

io.on("connection", (socket) => {
    socket.on("joinRoom", ({ roomId, name }) => {
        const nextRoomId = (roomId || "").trim();
        if (!nextRoomId) return;

        const prevRoom = socket.data.roomId;
        if (prevRoom && prevRoom !== nextRoomId && rooms[prevRoom]) {
            socket.leave(prevRoom);
            delete rooms[prevRoom].scrambles[socket.id];
            delete rooms[prevRoom].names[socket.id];
            delete rooms[prevRoom].solves[socket.id];
            delete rooms[prevRoom].raceEnabled[socket.id];
            delete rooms[prevRoom].round.ready[socket.id];
            delete rooms[prevRoom].round.finishes[socket.id];
            io.to(prevRoom).emit("removeUser", socket.id);
            transferHost(rooms[prevRoom], prevRoom);
            broadcastRaceState(prevRoom);

            const stillMembers = io.sockets.adapter.rooms.get(prevRoom);
            if (!stillMembers || stillMembers.size === 0) delete rooms[prevRoom];
        }

        socket.join(nextRoomId);
        socket.data.roomId = nextRoomId;
        socket.data.name = name || "Anonymous";

        if (!rooms[nextRoomId]) {
            rooms[nextRoomId] = createRoom(socket.id);
        }

        if (!rooms[nextRoomId].solves[socket.id]) {
            rooms[nextRoomId].solves[socket.id] = [];
        }

        rooms[nextRoomId].names[socket.id] = socket.data.name;

        socket.emit("initState", getInitPayload(rooms[nextRoomId]));
        socket.to(nextRoomId).emit("raceState", buildRaceState(rooms[nextRoomId]));

        broadcastRoomsChanged();
    });

    socket.on("listRooms", () => {
        socket.emit("roomsList", { rooms: getActiveRoomsSummary() });
    });

    socket.on("toggleRaceMode", ({ enabled }) => {
        const roomId = socket.data.roomId;
        const room = roomId && rooms[roomId];
        if (!room) return;
        if (!canToggleRaceMode(room)) return;

        if (enabled) room.raceEnabled[socket.id] = true;
        else delete room.raceEnabled[socket.id];

        broadcastRaceState(roomId);
    });

    socket.on("raceReady", () => {
        const roomId = socket.data.roomId;
        const room = roomId && rooms[roomId];
        if (!room || room.round.phase !== "ready") return;
        if (!room.raceEnabled[socket.id]) return;

        room.round.ready[socket.id] = true;
        if (!room.round.finishes[socket.id]) {
            room.round.finishes[socket.id] = {
                time: null,
                finishOrder: 0,
                done: false,
                startedAt: null,
                startPenalty: 0,
            };
        }

        broadcastRaceState(roomId);

        if (allRaceParticipantsReady(room, roomId)) {
            startInspection(room, roomId);
        }
    });

    socket.on("raceSolveStart", () => {
        const roomId = socket.data.roomId;
        const room = roomId && rooms[roomId];
        if (!room || !isRaceSolvingPhase(room.round.phase)) return;
        if (!room.raceEnabled[socket.id]) return;

        const f = room.round.finishes[socket.id];
        if (!f || f.done || f.startedAt) return;

        const now = Date.now();
        if (now >= room.round.inspectionDnfAt) return;

        f.startedAt = now;
        f.startPenalty = raceStartPenalty(room, now);

        broadcastRaceState(roomId);
    });

    socket.on("raceUnready", () => {
        const roomId = socket.data.roomId;
        const room = roomId && rooms[roomId];
        if (!room || room.round.phase !== "ready") return;
        if (!room.raceEnabled[socket.id]) return;

        room.round.ready[socket.id] = false;
        broadcastRaceState(roomId);
    });

    socket.on("nextRound", () => {
        const roomId = socket.data.roomId;
        const room = roomId && rooms[roomId];
        if (!room || room.hostId !== socket.id) return;
        if (room.round.phase !== "idle" && room.round.phase !== "results") return;

        beginNextRound(room, roomId);
    });

    socket.on("endRound", () => {
        const roomId = socket.data.roomId;
        const room = roomId && rooms[roomId];
        if (!room || room.hostId !== socket.id) return;
        if (room.round.phase !== "ready" && !isRaceSolvingPhase(room.round.phase)) {
            return;
        }

        const ids = getRaceParticipantIds(room, roomId);
        for (const sid of ids) {
            if (!room.round.finishes[sid] || !room.round.finishes[sid].done) {
                if (!room.round.finishes[sid]) {
                    room.round.finishOrder += 1;
                    room.round.finishes[sid] = {
                        time: Infinity,
                        finishOrder: room.round.finishOrder,
                        done: true,
                    };
                } else {
                    room.round.finishes[sid].time = Infinity;
                    room.round.finishes[sid].done = true;
                }
            }
        }
        finishRoundToResults(room, roomId);
    });

    socket.on("scrambleUpdate", (data) => {
        const roomId = socket.data.roomId;
        const room = roomId && rooms[roomId];
        if (!room) return;
        if (room.raceEnabled[socket.id] && room.round.scramble) return;

        room.scrambles[socket.id] = data.scramble;
        io.to(roomId).emit("scrambleUpdate", {
            id: socket.id,
            name: socket.data.name,
            scramble: data.scramble,
        });
    });

    socket.on("solveEnd", (time) => {
        const roomId = socket.data.roomId;
        const room = roomId && rooms[roomId];
        if (!room) return;

        const t = parseFloat(time);
        if (isNaN(t)) return;

        const f = room.round.finishes[socket.id];
        const inRaceSolve =
            room.raceEnabled[socket.id] &&
            isRaceSolvingPhase(room.round.phase) &&
            f &&
            !f.done;

        let solveTime = t;
        if (inRaceSolve) {
            if (!f.startedAt) ensureRaceStarted(room, socket.id, t);
            if (!f.startedAt) {
                recordRaceFinish(room, roomId, socket.id, Infinity);
                solveTime = Infinity;
            } else {
                recordRaceFinish(room, roomId, socket.id, t);
                f.startPenalty = raceStartPenalty(room, f.startedAt);
                if (f.startPenalty && Number.isFinite(t)) {
                    solveTime = +(t + f.startPenalty).toFixed(2);
                }
            }
        }

        const userSolves = room.solves[socket.id];
        userSolves.push(solveTime);
        const ao5 = calcAoN(userSolves, 5);

        io.to(roomId).emit("solveUpdate", {
            id: socket.id,
            name: socket.data.name,
            time: solveTime,
            solves: [...userSolves],
            ao5,
            raceSolve: !!inRaceSolve,
        });
    });

    socket.on("updateLastSolve", (data) => {
        const roomId = socket.data.roomId;
        const room = roomId && rooms[roomId];
        if (!room) return;

        const userSolves = room.solves[socket.id];
        if (!userSolves || !userSolves.length) return;

        const last = userSolves.length - 1;

        if (data.type === "+2") {
            userSolves[last] = +(userSolves[last] + 2).toFixed(2);
        } else if (data.type === "DNF") {
            userSolves[last] = Infinity;
        }

        const ao5 = calcAoN(userSolves, 5);

        if (
            room.raceEnabled[socket.id] &&
            room.round.finishes[socket.id] &&
            room.round.finishes[socket.id].done &&
            (isRaceSolvingPhase(room.round.phase) || room.round.phase === "results")
        ) {
            room.round.finishes[socket.id].time = userSolves[last];
            emitRaceFinisher(room, roomId, socket.id);
            if (room.round.phase === "results") {
                room.round.rankings = computeRankings(room, roomId);
                io.to(roomId).emit("roundResults", { rankings: room.round.rankings });
            }
            broadcastRaceState(roomId);
        }

        io.to(roomId).emit("solveUpdate", {
            id: socket.id,
            name: socket.data.name,
            solves: [...userSolves],
            ao5,
        });
    });

    socket.on("clearSolves", () => {
        const roomId = socket.data.roomId;
        const room = roomId && rooms[roomId];
        if (!room) return;

        room.solves[socket.id] = [];
        io.to(roomId).emit("solveUpdate", {
            id: socket.id,
            name: socket.data.name,
            solves: [],
            ao5: null,
        });
    });

    socket.on("deleteSolve", ({ index }) => {
        const roomId = socket.data.roomId;
        const room = roomId && rooms[roomId];
        if (!room) return;

        const userSolves = room.solves[socket.id];
        if (!Array.isArray(userSolves) || userSolves.length === 0) return;

        const i = Number(index);
        if (!Number.isInteger(i) || i < 0 || i >= userSolves.length) return;

        userSolves.splice(i, 1);
        const ao5 = calcAoN(userSolves, 5);

        io.to(roomId).emit("solveUpdate", {
            id: socket.id,
            name: socket.data.name,
            solves: [...userSolves],
            ao5,
        });
    });

    socket.on("syncSolves", ({ solves }) => {
        const roomId = socket.data.roomId;
        const room = roomId && rooms[roomId];
        if (!room || !Array.isArray(solves)) return;

        const normalized = solves
            .slice(0, 1000)
            .map((v) => (v === null ? Infinity : parseFloat(v)))
            .filter((v) => Number.isFinite(v) || v === Infinity);

        room.solves[socket.id] = normalized;
        const ao5 = calcAoN(normalized, 5);

        io.to(roomId).emit("solveUpdate", {
            id: socket.id,
            name: socket.data.name,
            solves: [...normalized],
            ao5,
        });
    });

    socket.on("timeUpdate", (time) => {
        const roomId = socket.data.roomId;
        if (!roomId) return;
        socket.to(roomId).emit("timeUpdate", { id: socket.id, time });
    });

    socket.on("disconnect", () => {
        const roomId = socket.data.roomId;
        if (!roomId || !rooms[roomId]) return;

        const room = rooms[roomId];

        if (room.raceEnabled[socket.id]) {
            delete room.round.ready[socket.id];
            if (
                isRaceSolvingPhase(room.round.phase) &&
                room.round.finishes[socket.id] &&
                !room.round.finishes[socket.id].done
            ) {
                recordRaceFinish(room, roomId, socket.id, Infinity);
            } else if (room.round.phase === "ready") {
                delete room.round.finishes[socket.id];
                broadcastRaceState(roomId);
            }
        }

        delete room.scrambles[socket.id];
        delete room.names[socket.id];
        delete room.solves[socket.id];
        delete room.raceEnabled[socket.id];
        delete room.round.ready[socket.id];
        delete room.round.finishes[socket.id];

        io.to(roomId).emit("removeUser", socket.id);

        transferHost(room, roomId);
        broadcastRaceState(roomId);

        const members = io.sockets.adapter.rooms.get(roomId);
        if (!members || members.size === 0) {
            clearRoundTimers(room);
            delete rooms[roomId];
        }
        broadcastRoomsChanged();
    });
});

server.listen(3000, () => console.log("running"));
