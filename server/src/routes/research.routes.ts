import { Router } from "express";
import multer from "multer";
import { uploadToR2 }
  from "../services/r2.service";
const router = Router();

const upload = multer({
  storage: multer.memoryStorage()
});

const voiceUpload = upload.fields([
  {
    name: "voice_0",
    maxCount: 1
  },
  {
    name: "voice_1",
    maxCount: 1
  },
  {
    name: "voice_2",
    maxCount: 1
  },
  {
    name: "voice_3",
    maxCount: 1
  }
]);

router.post(
  "/",
  voiceUpload,
  async (req, res) => {
    try {
      const filesByField =
        (req.files ?? {}) as Partial<
          Record<
            | "voice_0"
            | "voice_1"
            | "voice_2"
            | "voice_3",
            Express.Multer.File[]
          >
        >;

      const files =
        [
          ...(filesByField.voice_0 ?? []),
          ...(filesByField.voice_1 ?? []),
          ...(filesByField.voice_2 ?? []),
          ...(filesByField.voice_3 ?? [])
        ];

      if (files.length === 0) {
        return res.status(400).json({
          success: false,
          error: "No files received"
        });
      }

      const objectKeys =
        await Promise.all(
          files.map(async file => {
            const objectKey =
              `test/${Date.now()}-${file.originalname}`;

            console.log(
              "UPLOADING:",
              objectKey
            );

            await uploadToR2(
              objectKey,
              file.buffer,
              file.mimetype
            );

            console.log(
              "UPLOAD COMPLETE"
            );

            return objectKey;
          })
        );

      return res.json({
        success: true,
        objectKey:
          objectKeys[0],
        objectKeys
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
