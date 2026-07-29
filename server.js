const http = require('http');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/api/v1/health') {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return res.end(JSON.stringify({
        status: 'ok',
        database: 'connected',
        version: '1.0.0',
        name: 'ConstructFlow API'
      }));
    } catch (err) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ status: 'error', database: 'disconnected' }));
    }
  }

  res.end(JSON.stringify({
    message: 'ConstructFlow API rodando!',
    routes: [
      'GET /api/v1/health - Verificar status',
      'POST /api/v1/auth/register - Criar conta'
    ]
  }));
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`API rodando na porta ${PORT}`));
