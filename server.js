const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = {};

function getActiveRoomsSummary() {
    const out = [];
    const adapterRooms = io.sockets.adapter.rooms; // Map<string, Set<string>>

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

    // WCA-style trimmed mean: drop one best and one worst. Ties: earliest attempt
    // among equals is "best", latest is "worst" (sort by time, then by attempt order).
    const seg = arr.slice(-n);
    const indexed = seg.map((t, i) => ({ t, i }));
    indexed.sort((a, b) => (a.t !== b.t ? a.t - b.t : a.i - b.i));
    const middle = indexed.slice(1, -1).map((x) => x.t);
    // Keep Infinity as DNF: if any remaining counted solve is DNF, average is DNF.
    if (middle.some((v) => !Number.isFinite(v))) return Infinity;

    const sum = middle.reduce((a, b) => a + b, 0);
    return +(sum / middle.length).toFixed(2);
}

io.on("connection", (socket) => {

    // ---------------- JOIN ----------------
    socket.on("joinRoom", ({ roomId, name }) => {

        const nextRoomId = (roomId || "").trim();
        if (!nextRoomId) return;

        // If user was in a previous room, leave it and clean up server state.
        const prevRoom = socket.data.roomId;
        if (prevRoom && prevRoom !== nextRoomId && rooms[prevRoom]) {
            socket.leave(prevRoom);
            delete rooms[prevRoom].scrambles[socket.id];
            delete rooms[prevRoom].names[socket.id];
            delete rooms[prevRoom].solves[socket.id];
            io.to(prevRoom).emit("removeUser", socket.id);

            const stillMembers = io.sockets.adapter.rooms.get(prevRoom);
            if (!stillMembers || stillMembers.size === 0) delete rooms[prevRoom];
        }

        socket.join(nextRoomId);

        socket.data.roomId = nextRoomId;
        socket.data.name = name || "Anonymous";

        if (!rooms[nextRoomId]) {
            rooms[nextRoomId] = {
                scrambles: {},
                names: {},
                solves: {} // array pro user
            };
        }

        if (!rooms[nextRoomId].solves[socket.id]) {
            rooms[nextRoomId].solves[socket.id] = [];
        }

        rooms[nextRoomId].names[socket.id] = socket.data.name;

        socket.emit("initState", {
            scrambles: rooms[nextRoomId].scrambles,
            names: rooms[nextRoomId].names,
            solves: rooms[nextRoomId].solves
        });

        broadcastRoomsChanged();
    });

    // ---------------- LIST ROOMS ----------------
    socket.on("listRooms", () => {
        socket.emit("roomsList", { rooms: getActiveRoomsSummary() });
    });

    // ---------------- SCRAMBLE ----------------
    socket.on("scrambleUpdate", (data) => {

        const room = socket.data.roomId;
        if (!room) return;

        rooms[room].scrambles[socket.id] = data.scramble;

        io.to(room).emit("scrambleUpdate", {
            id: socket.id,
            name: socket.data.name,
            scramble: data.scramble
        });
    });

    // ---------------- SOLVE END ----------------
    socket.on("solveEnd", (time) => {
console.log("solveEnd empfangen:", time, "| room:", socket.data.roomId);
    const room = socket.data.roomId;
    if (!room) return;

    const t = parseFloat(time);
    if (isNaN(t)) return;

    const userSolves = rooms[room].solves[socket.id];

    userSolves.push(t);

    

    const ao5 = calcAoN(userSolves, 5);

    io.to(room).emit("solveUpdate", {
        id: socket.id,
        name: socket.data.name,
        time: t,
        solves: [...userSolves],   // 👈 WICHTIG
        ao5
    });
});
// ---------------- PENALTY UPDATE ----------------
socket.on("updateLastSolve", (data) => {
    const room = socket.data.roomId;
    if (!room) return;

    const userSolves = rooms[room].solves[socket.id];
    if (!userSolves || !userSolves.length) return;

    let last = userSolves.length - 1;

    if (data.type === "+2") {
        userSolves[last] = +(userSolves[last] + 2).toFixed(2);
    } else if (data.type === "DNF") {
        userSolves[last] = Infinity;
    }

    const ao5 = calcAoN(userSolves, 5);

    io.to(room).emit("solveUpdate", {
        id: socket.id,
        name: socket.data.name,
        solves: [...userSolves],
        ao5
    });
});

// ---------------- CLEAR SOLVES ----------------
socket.on("clearSolves", () => {
    const room = socket.data.roomId;
    if (!room || !rooms[room]) return;

    rooms[room].solves[socket.id] = [];

    io.to(room).emit("solveUpdate", {
        id: socket.id,
        name: socket.data.name,
        solves: [],
        ao5: null
    });
});

// ---------------- DELETE SOLVE ----------------
socket.on("deleteSolve", ({ index }) => {
    const room = socket.data.roomId;
    if (!room || !rooms[room]) return;

    const userSolves = rooms[room].solves[socket.id];
    if (!Array.isArray(userSolves) || userSolves.length === 0) return;

    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= userSolves.length) return;

    userSolves.splice(i, 1);
    const ao5 = calcAoN(userSolves, 5);

    io.to(room).emit("solveUpdate", {
        id: socket.id,
        name: socket.data.name,
        solves: [...userSolves],
        ao5
    });
});

// ---------------- SYNC SOLVES (from localStorage) ----------------
socket.on("syncSolves", ({ solves }) => {
    const room = socket.data.roomId;
    if (!room || !rooms[room]) return;
    if (!Array.isArray(solves)) return;

    // JSON can't represent Infinity; client may send null for DNF.
    const normalized = solves
        .slice(0, 1000)
        .map((v) => (v === null ? Infinity : parseFloat(v)))
        .filter((v) => Number.isFinite(v) || v === Infinity);

    rooms[room].solves[socket.id] = normalized;
    const ao5 = calcAoN(normalized, 5);

    io.to(room).emit("solveUpdate", {
        id: socket.id,
        name: socket.data.name,
        solves: [...normalized],
        ao5
    });
});
    socket.on("timeUpdate", (time) => {
        const room = socket.data.roomId;
        if (!room) return;
            socket.to(room).emit("timeUpdate", { id: socket.id, time });
    });
    // ---------------- DISCONNECT ----------------
    socket.on("disconnect", () => {

        const room = socket.data.roomId;
        if (!room || !rooms[room]) return;

        delete rooms[room].scrambles[socket.id];
        delete rooms[room].names[socket.id];
        delete rooms[room].solves[socket.id];

        io.to(room).emit("removeUser", socket.id);

        const members = io.sockets.adapter.rooms.get(room);
        if (!members || members.size === 0) delete rooms[room];
        broadcastRoomsChanged();
    });
    

});


server.listen(3000, () => console.log("running"));