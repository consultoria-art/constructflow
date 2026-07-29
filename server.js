const http = require('http');

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/api/v1/health') {
    return res.end(JSON.stringify({
      status: 'ok',
      version: '1.0.0',
      name: 'ConstructFlow API',
      timestamp: new Date().toISOString()
    }));
  }

  if (req.url === '/') {
    return res.end(JSON.stringify({
      message: 'ConstructFlow API rodando!',
      routes: ['GET /api/v1/health']
    }));
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'Rota não encontrada' }));
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => console.log(`API rodando na porta ${PORT}`));
