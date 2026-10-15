import path from 'path';
import { cpSync, existsSync, rmSync } from 'fs';

function copyFiles() {
    const targetDir = path.join(process.cwd(), 'dist', '_next');
    if (existsSync(targetDir)) {
        const sourceDir = path.join(process.cwd(), 'scripts/resources');
        cpSync(sourceDir, targetDir, { recursive: true });
    }
};

function cleanUpFiles() {
    const targetDir = path.join(process.cwd(), 'dist', '_next');
    if (existsSync(targetDir)) {
        // delete folders
        const folders = [
            path.join(process.cwd(), 'dist', '_not-found')
        ];
        for (const folder of folders) {
            rmSync(folder, { recursive: true });
        }

        // delete files
        const files = [
            path.join(process.cwd(), 'dist', '404.html'),
            path.join(process.cwd(), 'dist', 'index.txt'),
            path.join(process.cwd(), 'dist', '__next._full.txt'),
            path.join(process.cwd(), 'dist', '__next._head.txt'),
            path.join(process.cwd(), 'dist', '__next._index.txt'),
            path.join(process.cwd(), 'dist', '__next.__PAGE__.txt'),
            path.join(process.cwd(), 'dist', '__next._tree.txt'),
            path.join(process.cwd(), 'dist', '_not-found.html'),
            path.join(process.cwd(), 'dist', '_not-found.txt')
        ];
        for (const file of files) {
            rmSync(file);
        }
    }
}

copyFiles();
cleanUpFiles();
