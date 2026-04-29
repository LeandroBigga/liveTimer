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
                times: {},
                names: {}
            };
        }

        rooms[roomId].names[socket.id] = socket.data.name;

        socket.emit("initState", rooms[roomId]);
    });

    // ---------------- TIMER ----------------
    socket.on("timeUpdate", (time) => {

        const room = socket.data.roomId;
        if (!room) return;

        rooms[room].times[socket.id] = time;

        io.to(room).emit("timeUpdate", {
            id: socket.id,
            name: socket.data.name,
            time
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

    // ---------------- DISCONNECT ----------------
    socket.on("disconnect", () => {

        const room = socket.data.roomId;
        if (!room || !rooms[room]) return;

        delete rooms[room].scrambles[socket.id];
        delete rooms[room].times[socket.id];
        delete rooms[room].names[socket.id];

        io.to(room).emit("removeUser", socket.id);
    });

});

server.listen(3000, () => console.log("running"));