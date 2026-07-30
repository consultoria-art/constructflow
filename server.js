// Remover um produto (DELETE) - CORRIGIDO
app.delete('/produtos/:id', async (req, res) => {
    try {
        const { id } = req.params; // Correção aqui: extração direta de req.params
        await prisma.produto.delete({
            where: { id: parseInt(id) }
        });
        res.json({ success: true, message: "Produto removido com sucesso" });
    } catch (error) {
        res.status(400).json({ error: "Erro ao remover produto", details: error.message });
    }
});
