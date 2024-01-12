import { configureStore } from '@reduxjs/toolkit'
import pagesSlice from './features/pages/pagesSlice'

export const makeStore = () => {
  return configureStore({
    reducer: {
      pages: pagesSlice
    }
  })
}

// Infer the type of makeStore
export type AppStore = ReturnType<typeof makeStore>
// Infer the `RootState` and `AppDispatch` types from the store itself
export type RootState = ReturnType<AppStore['getState']>
export type AppDispatch = AppStore['dispatch']

