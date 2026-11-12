"use client";

import { RecognitionShell, RecognitionNotice } from "@/components/recognition/shared";
import styles from "@/components/recognition/recognition.module.css";

export default function RecognitionError({ reset }: { reset: () => void }) { return <RecognitionShell><RecognitionNotice error><h1>This view could not finish.</h1><p>No private names are displayed. Reload to check the current original access.</p><button className={styles.primary} type="button" onClick={reset}>Reload recognition</button></RecognitionNotice></RecognitionShell>; }
