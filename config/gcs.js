const path = require('path');
const { Storage } = require('@google-cloud/storage');
if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
}

const storageOptions = {};
if (process.env.GCS_PROJECT_ID) storageOptions.projectId = process.env.GCS_PROJECT_ID;

if (process.env.GCS_KEYFILE) {
    storageOptions.keyFilename = path.resolve(__dirname, '../', process.env.GCS_KEYFILE);
}

const storage = new Storage(storageOptions);

function getBucketEmpleados() {
    return storage.bucket(process.env.BUCKET_EMPLEADOS || 'talenthub_central');
}

module.exports = { storage, getBucketEmpleados };
