import { createSlice, configureStore } from '@reduxjs/toolkit'

const pageSlice = createSlice({
  name: 'page',
  initialState: {
    pages: []
  },
  reducers: {
    setPages: (state, actions) => {
      state.pages += actions.payload
    },
  }
})

export const { setPages } = pageSlice.actions
export default pageSlice.reducer