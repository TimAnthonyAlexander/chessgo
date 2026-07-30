import { describe, expect, test } from 'bun:test'
import { INITIAL_DOWNLOAD_STATE, formatDownloadProgress, reduceDownloadState } from '../downloadState'

describe('reduceDownloadState', () => {
    test('starts idle', () => {
        expect(INITIAL_DOWNLOAD_STATE).toEqual({ status: 'idle' })
    })

    test('start -> checking', () => {
        expect(reduceDownloadState(INITIAL_DOWNLOAD_STATE, { type: 'start' })).toEqual({ status: 'checking' })
    })

    test('progress -> downloading, carrying loaded/total', () => {
        const state = reduceDownloadState({ status: 'checking' }, { type: 'progress', loaded: 10, total: 100 })
        expect(state).toEqual({ status: 'downloading', loaded: 10, total: 100 })
    })

    test('a later progress event overwrites the earlier one (not additive)', () => {
        let state = reduceDownloadState({ status: 'checking' }, { type: 'progress', loaded: 10, total: 100 })
        state = reduceDownloadState(state, { type: 'progress', loaded: 55, total: 100 })
        expect(state).toEqual({ status: 'downloading', loaded: 55, total: 100 })
    })

    test('complete -> ready, from either checking (cache hit) or downloading (finished)', () => {
        expect(reduceDownloadState({ status: 'checking' }, { type: 'complete' })).toEqual({ status: 'ready' })
        expect(
            reduceDownloadState({ status: 'downloading', loaded: 100, total: 100 }, { type: 'complete' }),
        ).toEqual({ status: 'ready' })
    })

    test('fail -> error, carrying the message, from any prior state', () => {
        expect(reduceDownloadState({ status: 'downloading', loaded: 1, total: 100 }, { type: 'fail', message: 'corrupt net' })).toEqual({
            status: 'error',
            message: 'corrupt net',
        })
    })

    test('reset -> idle, from any state including error', () => {
        expect(reduceDownloadState({ status: 'error', message: 'x' }, { type: 'reset' })).toEqual({ status: 'idle' })
        expect(reduceDownloadState({ status: 'ready' }, { type: 'reset' })).toEqual({ status: 'idle' })
    })
})

describe('formatDownloadProgress', () => {
    test('renders the Lichess-style "Downloaded X% of YMB" readout', () => {
        const total = 36 * 1024 * 1024
        const loaded = Math.round(total * 0.42)
        expect(formatDownloadProgress(loaded, total, 36)).toBe('Downloaded 42% of 36MB')
    })

    test('0 loaded renders 0%, not NaN or negative', () => {
        expect(formatDownloadProgress(0, 36 * 1024 * 1024, 36)).toBe('Downloaded 0% of 36MB')
    })

    test('loaded === total renders 100%, never over', () => {
        const total = 36 * 1024 * 1024
        expect(formatDownloadProgress(total, total, 36)).toBe('Downloaded 100% of 36MB')
        expect(formatDownloadProgress(total + 999, total, 36)).toBe('Downloaded 100% of 36MB') // clamped
    })

    test('total=0 (Content-Length omitted) falls back to the known wire size for both % and MB', () => {
        const fallbackMb = 36
        const loaded = Math.round(fallbackMb * 1024 * 1024 * 0.5)
        expect(formatDownloadProgress(loaded, 0, fallbackMb)).toBe('Downloaded 50% of 36MB')
    })
})
