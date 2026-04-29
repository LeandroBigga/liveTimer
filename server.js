const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = {};

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

        socket.join(roomId);

        socket.data.roomId = roomId;
        socket.data.name = name || "Anonymous";

        if (!rooms[roomId]) {
            rooms[roomId] = {
                scrambles: {},
                names: {},
                solves: {} // array pro user
            };
        }

        if (!rooms[roomId].solves[socket.id]) {
            rooms[roomId].solves[socket.id] = [];
        }

        rooms[roomId].names[socket.id] = socket.data.name;

        socket.emit("initState", {
            scrambles: rooms[roomId].scrambles,
            names: rooms[roomId].names,
            solves: rooms[roomId].solves
        });
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
    });
    

});


server.listen(3000, () => console.log("running"));