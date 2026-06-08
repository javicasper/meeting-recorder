// IndexedDB persistence for recordings and their transcriptions.

const DB_NAME = 'meeting-recorder-db'
const DB_VERSION = 2
const RECORDINGS_STORE = 'recordings'
const TRANSCRIPTIONS_STORE = 'transcriptions'

const openDatabase = () =>
  new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('IndexedDB no disponible'))
      return
    }

    const request = window.indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result

      if (!db.objectStoreNames.contains(RECORDINGS_STORE)) {
        const store = db.createObjectStore(RECORDINGS_STORE, { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt', { unique: false })
      }

      if (!db.objectStoreNames.contains(TRANSCRIPTIONS_STORE)) {
        const store = db.createObjectStore(TRANSCRIPTIONS_STORE, {
          keyPath: 'recordingId',
        })
        store.createIndex('createdAt', 'createdAt', { unique: false })
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

export const getAllRecordingsFromDb = async () => {
  const db = await openDatabase()

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(RECORDINGS_STORE, 'readonly')
    const store = transaction.objectStore(RECORDINGS_STORE)
    const request = store.getAll()

    request.onsuccess = () => {
      const sorted = request.result.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      )
      resolve(sorted)
    }
    request.onerror = () => reject(request.error)

    transaction.oncomplete = () => db.close()
    transaction.onerror = () => db.close()
  })
}

export const saveRecordingToDb = async (recording) => {
  const db = await openDatabase()

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(RECORDINGS_STORE, 'readwrite')
    const store = transaction.objectStore(RECORDINGS_STORE)

    store.put(recording)

    transaction.oncomplete = () => {
      db.close()
      resolve()
    }
    transaction.onerror = () => {
      db.close()
      reject(transaction.error)
    }
  })
}

export const getAllTranscriptionsFromDb = async () => {
  const db = await openDatabase()

  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(TRANSCRIPTIONS_STORE)) {
      db.close()
      resolve([])
      return
    }

    const transaction = db.transaction(TRANSCRIPTIONS_STORE, 'readonly')
    const store = transaction.objectStore(TRANSCRIPTIONS_STORE)
    const request = store.getAll()

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)

    transaction.oncomplete = () => db.close()
    transaction.onerror = () => db.close()
  })
}

export const saveTranscriptionToDb = async (result) => {
  const db = await openDatabase()

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(TRANSCRIPTIONS_STORE, 'readwrite')
    const store = transaction.objectStore(TRANSCRIPTIONS_STORE)

    store.put(result)

    transaction.oncomplete = () => {
      db.close()
      resolve()
    }
    transaction.onerror = () => {
      db.close()
      reject(transaction.error)
    }
  })
}

export const deleteTranscriptionFromDb = async (recordingId) => {
  const db = await openDatabase()

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(TRANSCRIPTIONS_STORE, 'readwrite')
    const store = transaction.objectStore(TRANSCRIPTIONS_STORE)

    store.delete(recordingId)

    transaction.oncomplete = () => {
      db.close()
      resolve()
    }
    transaction.onerror = () => {
      db.close()
      reject(transaction.error)
    }
  })
}

export const deleteRecordingFromDb = async (recordingId) => {
  const db = await openDatabase()

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(RECORDINGS_STORE, 'readwrite')
    const store = transaction.objectStore(RECORDINGS_STORE)

    store.delete(recordingId)

    transaction.oncomplete = () => {
      db.close()
      resolve()
    }
    transaction.onerror = () => {
      db.close()
      reject(transaction.error)
    }
  })
}
