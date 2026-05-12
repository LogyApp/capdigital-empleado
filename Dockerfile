# Usamos una imagen ligera de Node.js
FROM node:20-slim

# Directorio de trabajo en el contenedor
WORKDIR /usr/src/app

# Copiamos los archivos de dependencias
COPY package*.json ./

# Instalamos solo dependencias de producción
RUN npm install --only=production

# Copiamos el resto del código
COPY . .

# Exponemos el puerto que usa Cloud Run (8080 por defecto)
EXPOSE 8080

# Comando para arrancar la aplicación
CMD [ "npm", "start" ]