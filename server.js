const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = {};

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

    if (userSolves.length > 5) {
        userSolves.shift();
    }

    const ao5 = calcAO5(userSolves);

    io.to(room).emit("solveUpdate", {
        id: socket.id,
        name: socket.data.name,
        time: t,
        solves: [...userSolves],   // 👈 WICHTIG
        ao5
    });
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

// ---------------- AO5 FIX ----------------
function calcAO5(arr) {
    if (arr.length < 5) return null;

    const last5 = arr.slice(-5).sort((a, b) => a - b);

    const middle = last5.slice(1, 4);

    const sum = middle.reduce((a, b) => a + b, 0);

    return +(sum / 3).toFixed(2);
}

server.listen(3000, () => console.log("running"));