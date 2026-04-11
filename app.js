const express = require('express');
const path = require('path');

if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config({ path: path.resolve(__dirname, '.env') });
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/empleado', require('./routes/empleado'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
});

module.exports = app;
