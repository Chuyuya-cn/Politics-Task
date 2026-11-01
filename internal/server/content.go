package server

import (
	"io/fs"
	"os"
	"path/filepath"
)

var backgroundExtensions = map[string]bool{
	".jpg":  true,
	".jpeg": true,
	".png":  true,
	".webp": true,
	".svg":  true,
}

var promptExtensions = map[string]bool{
	".md":  true,
	".txt": true,
}

// seedIfEmpty copies the bundled defaults into a writable content folder when
// the folder has no usable files yet. Existing user files are never replaced.
func seedIfEmpty(seedFS fs.FS, sourceDir, targetDir string) error {
	entries, err := os.ReadDir(targetDir)
	if err != nil {
		if os.IsNotExist(err) {
			if err := os.MkdirAll(targetDir, 0o755); err != nil {
				return err
			}
		} else {
			return err
		}
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			return nil
		}
	}

	return fs.WalkDir(seedFS, sourceDir, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(sourceDir, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		dest := filepath.Join(targetDir, filepath.FromSlash(rel))
		if entry.IsDir() {
			return os.MkdirAll(dest, 0o755)
		}
		data, err := fs.ReadFile(seedFS, path)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(dest, data, 0o644); err != nil {
			return err
		}
		return nil
	})
}

func isSupportedImage(name string) bool {
	return backgroundExtensions[filepath.Ext(name)]
}
