import process from 'node:process';

export async function uploadSftp(client, localDir, remoteDir) {
    console.log('[deploy] Mode: SFTP (Individual files). Uploading...');
    let count = 0;
    
    const onUpload = (info) => {
        count++;
        // Simple spinner-like progress
        if (process.stdout.isTTY) {
             process.stdout.write(`\r[deploy] Uploading: ${count} files transferred...`);
        } else if (count % 100 === 0) {
             console.log(`[deploy] Uploading: ${count} files...`);
        }
    };
    
    client.on('upload', onUpload);
    
    try {
        await client.uploadDir(localDir, remoteDir);
    } finally {
        client.removeListener('upload', onUpload);
    }
    
    if (process.stdout.isTTY) process.stdout.write('\n');
    console.log('[deploy] Upload complete.');
}
