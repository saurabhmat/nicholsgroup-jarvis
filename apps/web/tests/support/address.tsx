// Test support: the address (`?...`) a component under test sees through `useSearchParams`, given by a React context instead of a mutated global (so a test wrapper stays a pure component).
import { createContext, useContext } from "react";

export const AddressContext = createContext("");
export const useTestSearchParams = (): URLSearchParams => new URLSearchParams(useContext(AddressContext));
