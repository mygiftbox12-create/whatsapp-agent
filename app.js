const express = require('express');
const app = express();
app.use(express.json());

app.get('/webhook', (req, res) => {
  const verify_token = process.env.VERIFY_TOKEN || "myshirt2025";
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === verify_token) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', (req, res) => {
  res.sendStatus(200);
});

app.listen(3000, () => console.log('Server running on port 3000'));
