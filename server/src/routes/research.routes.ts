import { Router } from "express";
import multer from "multer";
import { uploadToR2 }
  from "../services/r2.service";
const router = Router();

const upload = multer({
  storage: multer.memoryStorage()
});

router.post(
  "/",
  upload.any(),
  async (req, res) => {
    try {
      const files =
        (req.files as Express.Multer.File[]) ??
        [];

      if (files.length === 0) {
        return res.status(400).json({
          success: false,
          error: "No files received"
        });
      }

      const firstFile =
        files[0];

      const objectKey =
        `test/${Date.now()}-${firstFile.originalname}`;

        console.log(
  "UPLOADING:",
  objectKey
);
      await uploadToR2(
        objectKey,
        firstFile.buffer,
        firstFile.mimetype
      );
      console.log(
  "UPLOAD COMPLETE"
);

      return res.json({
        success: true,
        objectKey
      });
    }
    catch (error) {
      console.error(error);

      return res.status(500).json({
        success: false,
        error:
          "R2 upload failed"
      });
    }
  }
);

router.get("/", (_req, res) => {
  res.json({
    success: true
  });
});

export default router;