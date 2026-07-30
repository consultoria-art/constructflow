const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 3000;

// Configurações obrigatórias
app.use(cors());
app.use(express.json());

// Rota inicial de diagnóstico
app.get('/', (req, res) => {
    res.json({ status: "OK", message: "Servidor ConstructFlow operando com módulo de produtos ativo!" });
});

// =========================================================================
// MÓDULO DE PRODUTOS
// =========================================================================

// Buscar todos os produtos (GET)
app.get('/produtos', async (req, res) => {
    try {
        const produtos = await prisma.produto.findMany();
        res.json(produtos);
    } catch (error) {
        res.status(500).json({ error: "Erro ao buscar produtos", details: error.message });
    }
});

// Adicionar um novo produto (POST)
app.post('/produtos', async (req, res) => {
    try {
        const { nome, preco, estoque } = req.body;
        const novoProduto = await prisma.produto.create({
            data: {
                nome,
                preco: parseFloat(preco),
                estoque: parseInt(estoque)
            }
        });
        res.status(201).json(novoProduto);
    } catch (error) {
        res.status(400).json({ error: "Erro ao salvar produto", details: error.message });
    }
});

// Remover um produto (DELETE) - CORRIGIDO
app.delete('/produtos/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await prisma.produto.delete({
            where: { id: parseInt(id) }
        });
        res.json({ success: true, message: "Produto removido com sucesso" });
    } catch (error) {
        res.status(400).json({ error: "Erro ao remover produto", details: error.message });
    }
});

// Inicialização do servidor
app.listen(PORT, () => {
    console.log(`Servidor rodando com sucesso na porta ${PORT}`);
});
