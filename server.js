const express = require('express');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 888;

app.use(express.json());

app.get('/', (req, res) => {
    res.send('OK: porta 888');
});

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
