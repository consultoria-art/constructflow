const express = require('express');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Rota de teste para validar se o servidor subiu com sucesso
app.get('/', (req, res) => {
    res.json({ status: "OK", message: "Servidor ConstructFlow funcionando corretamente!" });
});

// Inicialização do servidor na porta configurada pelo ambiente
app.listen(PORT, () => {
    console.log(`Servidor rodando com sucesso na porta ${PORT}`);
});
