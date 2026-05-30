const express = require("express");

const app = express();

const PORT = process.env.PORT || 3000;

let currentCommand = {
    led: false
};

app.get("/", (req, res) => {
    res.send("ESP32 Server Running");
});

app.get("/command", (req, res) => {
    res.json(currentCommand);
});

app.get("/led/on", (req, res) => {
    currentCommand.led = true;
    res.send("LED ON");
});

app.get("/led/off", (req, res) => {
    currentCommand.led = false;
    res.send("LED OFF");
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});