const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const ROOM = "global";

// ---------- WCA SCRAMBLE ----------
function generateWCAScramble() {
    const axes = {
        X: ["R", "L"],
        Y: ["U", "D"],
        Z: ["F", "B"]
    };

    const suffix = ["", "'", "2"];
    const axisKeys = Object.keys(axes);

    let scramble = [];
    let lastAxis = null;

    for (let i = 0; i < 20; i++) {
        let axis;

        do {
            axis = axisKeys[Math.floor(Math.random() * axisKeys.length)];
        } while (axis === lastAxis);

        lastAxis = axis;

        const move = axes[axis][Math.floor(Math.random() * 2)];
        const mod = suffix[Math.floor(Math.random() * suffix.length)];

        scramble.push(move + mod);
    }

    return scramble.join(" ");
}

let currentScramble = generateWCAScramble();

// ---------- SOCKET ----------
io.on("connection", (socket) => {
    socket.join(ROOM);

    // sofort aktuellen Scramble senden
    socket.emit("scrambleUpdate", currentScramble);

    // Zeit sync
    socket.on("timeUpdate", (time) => {
        socket.to(ROOM).emit("timeUpdate", time);
    });

    // optional: neuer Scramble für alle
    socket.on("newScramble", () => {
        currentScramble = generateWCAScramble();
        io.to(ROOM).emit("scrambleUpdate", currentScramble);
    });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log("Server läuft auf Port " + PORT);
});